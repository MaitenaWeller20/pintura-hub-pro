import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { NumberInput } from "@/components/ui/number-input";
import { buscarProductosIngreso } from "@/lib/ingresos.functions";
import { uuidv4 } from "@/lib/uuid";
import { ArrowLeft, Loader2, Search, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/ingresos-mercaderia/nuevo")({
  validateSearch: (s: Record<string, unknown>) => ({ id: (s.id as string) || undefined }),
  component: NuevoIngreso,
});

// Ingreso de mercadería A MANO.
//
// Hasta el 29/07/2026 esta pantalla subía una foto o un PDF del remito y lo leía
// un modelo. El cliente lo bajó: "es un bardo lo de cargarlo con una foto, con un
// PDF; lo vamos a hacer a mano". Se busca el producto en el catálogo y se pone
// cuánto entró.
//
// El motor NO cambió: crear_borrador_ingreso / actualizar_items_borrador /
// confirmar_ingreso_mercaderia son las mismas RPC de siempre, con su transacción,
// su kardex y sus validaciones. Esto es sólo la puerta de entrada.
// Ver docs/superpowers/specs/2026-07-29-compras-plata-ingresos-mano-design.md

type Fila = {
  /** Clave de React y número de línea del remito. */
  linea: number;
  producto_id: string;
  codigo: string;
  descripcion: string;
  cantidad: number | null;
  /**
   * El código con el que ESTE proveedor llama a este producto. Arranca con el
   * código interno y se puede cambiar por el del remito.
   *
   * No es decorativo: `confirmar_ingreso_mercaderia` lo guarda en
   * `producto_codigos_proveedor`, que es lo que hace que el próximo remito del
   * mismo proveedor se resuelva solo. Si esta pantalla no lo capturara, la tabla
   * que aprende dejaría de aprender.
   */
  codigo_proveedor: string;
};

function NuevoIngreso() {
  const navigate = useNavigate();
  const { data: cu } = useCurrentUser();
  const { id: idExistente } = Route.useSearch();

  const [ingresoId, setIngresoId] = useState<string | null>(idExistente ?? null);
  const [sucursalId, setSucursalId] = useState("");
  const [proveedorId, setProveedorId] = useState("");
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [filas, setFilas] = useState<Fila[]>([]);
  const [bloqueo, setBloqueo] = useState<string | null>(null);
  const [descartadas, setDescartadas] = useState({ sinProducto: 0, ignoradas: 0 });
  const [estadoIngreso, setEstadoIngreso] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [idempotencyKey] = useState(() => uuidv4());

  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: sucursales = [] } = useQuery({
    queryKey: ["sucursales"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const { data: proveedores = [] } = useQuery({
    queryKey: ["proveedores-activos"],
    queryFn: async () =>
      ((
        await supabase
          .from("proveedores")
          .select("id, razon_social")
          .eq("activo", true)
          .order("razon_social")
      ).data ?? []) as any[],
  });

  // Retomar un borrador. Puede ser uno viejo que quedó de la extracción con IA, y
  // ahí hay dos trampas que costaron caro:
  //
  //  - `confirmar_ingreso_mercaderia` hace DELETE + re-INSERT de lo que mande esta
  //    pantalla. Si se cargaran sólo las filas con producto, las que la IA no pudo
  //    matchear DESAPARECEN sin decir nada: mercadería del remito que nunca entra
  //    al stock.
  //  - Las filas marcadas IGNORADA se reenviaban como MANUAL, así que SÍ sumaban
  //    stock — justo lo que la usuaria había decidido que no entrara.
  //
  // Las dos se cuentan y se avisan: esta pantalla no puede representar esos
  // estados, así que lo mínimo honesto es decir cuántos quedaron afuera.
  useEffect(() => {
    if (!idExistente) return;
    (async () => {
      const { data: ing } = await supabase
        .from("ingresos_mercaderia")
        .select("*")
        .eq("id", idExistente)
        .maybeSingle();
      if (!ing) return;
      setSucursalId(ing.sucursal_id);
      setProveedorId(ing.proveedor_id);
      setNumero(ing.numero_remito_proveedor ?? "");
      if (ing.fecha_remito) setFecha(String(ing.fecha_remito).slice(0, 10));
      setBloqueo(ing.bloqueo_confirmacion ?? null);
      setEstadoIngreso(ing.estado ?? null);
      const { data: its } = await supabase
        .from("ingreso_mercaderia_items")
        .select("*")
        .eq("ingreso_id", idExistente)
        .order("linea");
      const todos = its ?? [];
      const usables = todos.filter((it: any) => it.producto_id && it.origen_match !== "IGNORADA");
      const sinProducto = todos.filter((it: any) => !it.producto_id).length;
      const ignoradas = todos.filter(
        (it: any) => it.producto_id && it.origen_match === "IGNORADA",
      ).length;
      setDescartadas({ sinProducto, ignoradas });
      setFilas(
        usables.map((it: any, i: number) => ({
          linea: i + 1,
          producto_id: it.producto_id,
          codigo: it.codigo ?? "",
          descripcion: it.descripcion ?? "",
          cantidad: it.cantidad == null ? null : Number(it.cantidad),
          codigo_proveedor: it.codigo_proveedor ?? it.codigo ?? "",
        })),
      );
    })();
  }, [idExistente]);

  // Buscador contra el catálogo — "tiene que buscarlo al producto en productos,
  // que sería la lista de precios que cargamos".
  //
  // Se manda lo tipeado en los DOS parámetros: `buscar_productos_similares` busca
  // por nombre en `p_texto` y por código sólo en `p_codigo`, así que mandando uno
  // solo la mitad de las búsquedas no encuentra nada. Buscar "4000-00400" tiene
  // que traer el producto igual que buscar "membrana".
  const { data: resultados = [], isFetching: buscando } = useQuery({
    queryKey: ["buscar-producto-ingreso", busqueda],
    enabled: busqueda.trim().length >= 2,
    queryFn: async () =>
      (await buscarProductosIngreso({
        data: { texto: busqueda.trim(), codigo: busqueda.trim() },
      })) as any[],
  });

  const agregar = (p: any) => {
    if (filas.some((f) => f.producto_id === p.id)) {
      toast.info("Ese producto ya está en la lista.");
      return;
    }
    setFilas((prev) => [
      ...prev,
      {
        linea: prev.length + 1,
        producto_id: p.id,
        codigo: p.codigo,
        descripcion: p.nombre,
        cantidad: null,
        codigo_proveedor: p.codigo,
      },
    ]);
    setBusqueda("");
  };

  const actualizar = (linea: number, patch: Partial<Fila>) =>
    setFilas((prev) => prev.map((f) => (f.linea === linea ? { ...f, ...patch } : f)));
  const borrar = (linea: number) =>
    setFilas((prev) =>
      prev.filter((f) => f.linea !== linea).map((f, i) => ({ ...f, linea: i + 1 })),
    );

  const listas = useMemo(() => filas.filter((f) => (f.cantidad ?? 0) > 0).length, [filas]);
  const sinCantidad = filas.length - listas;

  const confirmarM = useMutation({
    mutationFn: async () => {
      if (!effSucursal) throw new Error("Elegí la sucursal.");
      if (!proveedorId) throw new Error("Elegí el proveedor.");
      if (filas.length === 0) throw new Error("Agregá al menos un producto.");
      if (sinCantidad > 0) throw new Error("Hay productos sin cantidad.");
      if (bloqueo) throw new Error(bloqueo);

      // El borrador se crea recién acá si no existía: cargar la pantalla no tiene
      // por qué dejar borradores huérfanos.
      let id = ingresoId;
      if (!id) {
        const { data, error } = await supabase.rpc("crear_borrador_ingreso", {
          p_proveedor_id: proveedorId,
          p_sucursal_id: effSucursal,
        });
        if (error) throw new Error(error.message);
        id = data as string;
        setIngresoId(id);
      }

      const payload = filas.map((f) => ({
        linea: f.linea,
        producto_id: f.producto_id,
        codigo: f.codigo,
        descripcion: f.descripcion,
        cantidad: f.cantidad,
        codigo_proveedor: f.codigo_proveedor || f.codigo,
        descripcion_proveedor: f.descripcion,
        cantidad_raw: String(f.cantidad ?? ""),
        descripcion_raw: f.descripcion,
        pagina: 1,
        origen_match: "MANUAL",
        confianza: null,
        // Guarda la equivalencia código-del-proveedor → producto, que es lo que
        // hace que el próximo remito venga resuelto.
        aprender: true,
        pisar_equivalencia: false,
      }));

      const { error } = await supabase.rpc("confirmar_ingreso_mercaderia", {
        p_ingreso_id: id,
        p_numero: numero.trim() || undefined,
        p_fecha: fecha || undefined,
        p_items: payload as any,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Ingreso confirmado. Stock actualizado.");
      navigate({ to: "/ingresos-mercaderia" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nuevo ingreso de mercadería"
        subtitle="Buscá cada producto y poné cuánto entró"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={confirmarM.isPending}
            onClick={() => navigate({ to: "/ingresos-mercaderia" })}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver
          </Button>
        }
      />

      {/* Un borrador que la extracción dejó bloqueado no se puede confirmar ni
          corrigiéndolo a mano: la RPC lo rechaza siempre y no hay forma de
          limpiar el bloqueo. Mejor decirlo acá que dejar que choque contra un
          error que no puede resolver. */}
      {/* Un ingreso ya confirmado o anulado no se edita: la pantalla se cargaba
          igual y el error recién aparecía al confirmar. */}
      {estadoIngreso && estadoIngreso !== "BORRADOR" && (
        <SectionCard>
          <div className="flex gap-2 items-start text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
            <p>
              Este ingreso está <strong>{estadoIngreso.toLowerCase()}</strong>: no se puede
              modificar. Si querés cargar otro remito, entrá por <strong>Nuevo ingreso</strong>.
            </p>
          </div>
        </SectionCard>
      )}

      {(descartadas.sinProducto > 0 || descartadas.ignoradas > 0) && (
        <SectionCard>
          <div className="flex gap-2 items-start text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-warning shrink-0" />
            <div>
              <p className="font-medium">Este borrador venía de la lectura automática.</p>
              <ul className="text-xs text-muted-foreground list-disc pl-4 mt-1">
                {descartadas.sinProducto > 0 && (
                  <li>
                    <strong>{descartadas.sinProducto}</strong> renglones no tenían producto asignado
                    y no se cargaron. Si estaban en el remito, buscalos y agregalos a mano.
                  </li>
                )}
                {descartadas.ignoradas > 0 && (
                  <li>
                    <strong>{descartadas.ignoradas}</strong> renglones estaban marcados para ignorar
                    y se dejaron afuera.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </SectionCard>
      )}

      {bloqueo && (
        <SectionCard>
          <div className="flex gap-2 items-start text-sm">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
            <p>
              Este borrador quedó bloqueado: <strong>{bloqueo}</strong>. No se puede confirmar ni
              corrigiéndolo a mano. Dejalo así —un borrador no toca el stock— y cargá el remito de
              nuevo desde <strong>Nuevo ingreso</strong>.
            </p>
          </div>
        </SectionCard>
      )}

      <SectionCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label>Sucursal *</Label>
            {cu.isAdmin ? (
              <Select value={effSucursal} onValueChange={setSucursalId}>
                <SelectTrigger data-testid="select-sucursal">
                  <SelectValue placeholder="Elegí…" />
                </SelectTrigger>
                <SelectContent>
                  {sucursales.map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nombre}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input value={cu.sucursal?.nombre ?? ""} disabled />
            )}
          </div>
          <div>
            <Label>Proveedor *</Label>
            <Select value={proveedorId} onValueChange={setProveedorId}>
              <SelectTrigger data-testid="select-proveedor">
                <SelectValue placeholder="Elegí…" />
              </SelectTrigger>
              <SelectContent>
                {proveedores.map((p: any) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.razon_social}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>N° de remito</Label>
            <Input
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              placeholder="0001-00001234"
            />
          </div>
          <div>
            <Label>Fecha</Label>
            <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="space-y-3">
          <div>
            <Label>Buscar producto por código o nombre</Label>
            <div className="relative max-w-xl">
              <Search className="h-4 w-4 absolute left-2 top-3 text-muted-foreground" />
              <Input
                className="pl-8"
                value={busqueda}
                onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Ej: 4000-00400 o membrana"
                data-testid="buscar-producto"
              />
              {buscando && <Loader2 className="h-4 w-4 animate-spin absolute right-2 top-3" />}
            </div>
          </div>

          {busqueda.trim().length >= 2 && (
            <div className="rounded-lg border border-border max-h-56 overflow-auto">
              {resultados.length === 0 && !buscando ? (
                <p className="p-3 text-sm text-muted-foreground">
                  No hay productos que coincidan. Si el producto no está en el catálogo, cargalo
                  primero en Productos.
                </p>
              ) : (
                resultados.map((p: any) => (
                  <button
                    key={p.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex gap-3"
                    onClick={() => agregar(p)}
                  >
                    <span className="font-mono text-xs w-32 shrink-0">{p.codigo}</span>
                    <span className="truncate">{p.nombre}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </SectionCard>

      <div className="rounded-2xl border border-border overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cantidad que entró</TableHead>
                <TableHead>Código del proveedor</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Buscá un producto arriba para agregarlo.
                  </TableCell>
                </TableRow>
              ) : (
                filas.map((f) => (
                  <TableRow key={f.linea} data-testid="fila-ingreso">
                    <TableCell className="font-mono text-xs">{f.codigo}</TableCell>
                    <TableCell>{f.descripcion}</TableCell>
                    <TableCell className="text-right">
                      <NumberInput
                        className="max-w-28 ml-auto"
                        value={f.cantidad}
                        onValueChange={(v) => actualizar(f.linea, { cantidad: v })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        className="max-w-40 font-mono text-xs"
                        value={f.codigo_proveedor}
                        onChange={(e) => actualizar(f.linea, { codigo_proveedor: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => borrar(f.linea)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <SectionCard>
        <div className="flex flex-wrap items-center gap-3 justify-between">
          <p className="text-sm text-muted-foreground">
            {filas.length === 0
              ? "Sin productos todavía."
              : `${listas} producto${listas === 1 ? "" : "s"} listo${listas === 1 ? "" : "s"}` +
                (sinCantidad > 0 ? ` · ${sinCantidad} sin cantidad` : "")}
          </p>
          <Button
            onClick={() => confirmarM.mutate()}
            disabled={
              confirmarM.isPending ||
              !!bloqueo ||
              (!!estadoIngreso && estadoIngreso !== "BORRADOR") ||
              filas.length === 0 ||
              sinCantidad > 0 ||
              !proveedorId ||
              !effSucursal
            }
            data-testid="confirmar-ingreso"
          >
            {confirmarM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Confirmar ingreso y sumar al stock
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
