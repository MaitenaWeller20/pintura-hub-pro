import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ClientePicker } from "@/components/cliente-picker";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/ui/number-input";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { fmtMoney } from "@/lib/format";
import { calcularTotales, conIva } from "@/lib/fiscal/iva";
import {
  filtroProducto,
  ordenarProductosPorRelevancia,
  TOPE_BUSQUEDA_PRODUCTOS,
} from "@/lib/postgrest";
import { toast } from "sonner";
import { ArrowLeft, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/presupuestos/editar/$id")({
  component: EditarPresupuesto,
});

/**
 * Editar un presupuesto ya hecho.
 *
 * La diferencia de fondo con /presupuestos/nuevo: acá cada línea que YA ESTABA
 * arrastra el precio con el que se la presupuestó, no el del catálogo de hoy.
 * Ver el comentario largo de la migración `editar_presupuesto`: repreciar sin
 * que nadie lo pida cambia lo que se le va a cobrar al cliente, porque la
 * conversión en venta factura con el precio guardado en la línea.
 */

type Fila = {
  producto_id: string;
  codigo: string;
  nombre: string;
  /** El precio con el que se presupuestó. null = línea agregada recién. */
  precio_snapshot: number | null;
  iva_snapshot: number | null;
  /** Lo que vale hoy en el catálogo. */
  precio_hoy: number;
  iva_hoy: number;
  cantidad: number | null;
  descuento: number | null;
};

/** Espejo exacto de la regla del servidor: snapshot salvo que se repricie. */
const precioDe = (f: Fila, repreciar: boolean) =>
  repreciar || f.precio_snapshot === null ? f.precio_hoy : f.precio_snapshot;
const ivaDe = (f: Fila, repreciar: boolean) =>
  repreciar || f.iva_snapshot === null ? f.iva_hoy : f.iva_snapshot;

function EditarPresupuesto() {
  const { id } = useParams({ from: "/_authenticated/presupuestos/editar/$id" });
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [clienteId, setClienteId] = useState("");
  const [nombreCliente, setNombreCliente] = useState("");
  const [validez, setValidez] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [repreciar, setRepreciar] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  // Guarda QUÉ presupuesto se volcó, no un simple "ya volqué": el router puede
  // reusar el componente al cambiar el $id, y con un booleano la pantalla
  // seguiría mostrando las líneas del presupuesto anterior.
  const [cargadoId, setCargadoId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["presupuesto-editar", id],
    queryFn: async () => {
      const { data: p, error: e1 } = await supabase
        .from("presupuestos")
        .select("*, sucursal:sucursales(nombre), items:presupuesto_items(*)")
        .eq("id", id)
        .single();
      if (e1) throw new Error(e1.message);

      // Los precios de HOY de esos mismos productos, para poder decir cuáles se
      // movieron desde que se hizo el presupuesto.
      const ids = (p.items ?? []).map((i: any) => i.producto_id);
      const { data: prods = [] } = ids.length
        ? await supabase
            .from("productos")
            .select("id, precio_sin_iva, iva_porcentaje")
            .in("id", ids)
        : { data: [] as any[] };
      return { p, hoy: new Map((prods ?? []).map((x: any) => [x.id, x])) };
    },
  });

  // Un solo volcado inicial: después manda lo que se esté editando en pantalla.
  useEffect(() => {
    if (!data || cargadoId === id) return;
    const { p, hoy } = data;
    setRepreciar(false);
    setClienteId(p.cliente_id ?? "");
    setNombreCliente(p.nombre_cliente ?? "");
    setValidez(p.validez_hasta ?? "");
    setObservaciones(p.observaciones ?? "");
    setFilas(
      (p.items ?? []).map((i: any) => ({
        producto_id: i.producto_id,
        codigo: i.codigo,
        nombre: i.descripcion,
        precio_snapshot: Number(i.precio_lista_sin_iva),
        iva_snapshot: Number(i.iva_porcentaje),
        // Si el producto ya no está en el catálogo (borrado), lo de hoy es lo
        // que había: sin esto la fila mostraría $0 y el cartel de "cambió de
        // precio" mentiría.
        precio_hoy: Number(hoy.get(i.producto_id)?.precio_sin_iva ?? i.precio_lista_sin_iva),
        iva_hoy: Number(hoy.get(i.producto_id)?.iva_porcentaje ?? i.iva_porcentaje),
        cantidad: Number(i.cantidad),
        descuento: Number(i.descuento_porcentaje),
      })),
    );
    setCargadoId(id);
  }, [data, cargadoId, id]);

  const { data: resultados = [], isFetching } = useQuery({
    queryKey: ["buscar-prod-presupuesto", busqueda],
    enabled: busqueda.trim().length >= 2,
    // Mismo arreglo que en presupuestos.nuevo: el tope de 10 sin `order` dejaba
    // productos afuera sin avisar.
    queryFn: async () => {
      const filtro = filtroProducto(busqueda);
      if (!filtro) return [] as any[];
      const filas = ((
        await supabase
          .from("productos")
          .select("id, codigo, nombre, precio_sin_iva, iva_porcentaje")
          .or(filtro)
          .eq("activo", true)
          .eq("archivado", false)
          .order("codigo")
          .limit(TOPE_BUSQUEDA_PRODUCTOS)
      ).data ?? []) as any[];
      // Por código el que se busca queda sepultado: "blanco" matchea 161 en
      // producción. Primero lo que arranca con lo tipeado.
      return ordenarProductosPorRelevancia(filas, busqueda);
    },
  });

  const agregar = (p: any) => {
    if (filas.some((f) => f.producto_id === p.id)) {
      toast.info("Ese producto ya está en el presupuesto: cambiale la cantidad.");
      return;
    }
    setFilas((prev) => [
      ...prev,
      {
        producto_id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        precio_snapshot: null, // línea nueva: va al precio de hoy
        iva_snapshot: null,
        precio_hoy: Number(p.precio_sin_iva),
        iva_hoy: Number(p.iva_porcentaje),
        cantidad: 1,
        descuento: 0,
      },
    ]);
    setBusqueda("");
  };
  const upd = (pid: string, patch: Partial<Fila>) =>
    setFilas((prev) => prev.map((f) => (f.producto_id === pid ? { ...f, ...patch } : f)));
  const borrar = (pid: string) => setFilas((prev) => prev.filter((f) => f.producto_id !== pid));

  /** Líneas ya presupuestadas cuyo precio de catálogo se movió. */
  const movidas = useMemo(
    () => filas.filter((f) => f.precio_snapshot !== null && f.precio_snapshot !== f.precio_hoy),
    [filas],
  );

  const totales = useMemo(() => {
    const r2 = (n: number) => +n.toFixed(2);
    let sub = 0,
      iva = 0;
    for (const f of filas) {
      const precio = r2(precioDe(f, repreciar) * (1 - Number(f.descuento || 0) / 100));
      const si = r2(precio * Number(f.cantidad || 0));
      sub += si;
      iva += r2((si * ivaDe(f, repreciar)) / 100);
    }
    return { sub: r2(sub), iva: r2(iva), total: r2(sub + iva) };
  }, [filas, repreciar]);

  const m = useMutation({
    mutationFn: async () => {
      if (filas.length === 0)
        throw new Error("Dejá al menos un producto. Si no querés ninguno, anulá el presupuesto.");
      if (filas.some((f) => !(Number(f.cantidad) > 0)))
        throw new Error("Hay productos sin cantidad.");
      const { data: r, error: e } = await supabase.rpc("editar_presupuesto", {
        p_presupuesto_id: id,
        p_items: filas.map((f) => ({
          producto_id: f.producto_id,
          cantidad: Number(f.cantidad),
          descuento_porcentaje: Number(f.descuento || 0),
        })) as any,
        p_cliente_id: clienteId || undefined,
        p_nombre_cliente: nombreCliente.trim() || undefined,
        p_validez_hasta: validez || undefined,
        p_observaciones: observaciones.trim() || undefined,
        p_repreciar: repreciar,
      });
      if (e) throw new Error(e.message);
      return (Array.isArray(r) ? r[0] : r) as any;
    },
    onSuccess: (r: any) => {
      toast.success(`Presupuesto ${r?.numero ?? ""} actualizado.`);
      qc.invalidateQueries({ queryKey: ["presupuestos"] });
      qc.invalidateQueries({ queryKey: ["presupuesto", id] });
      qc.invalidateQueries({ queryKey: ["presupuesto-editar", id] });
      navigate({ to: "/presupuestos/$id", params: { id } });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Cargando…</div>;
  if (error)
    return <div className="p-8 text-center text-destructive">{(error as any).message}</div>;

  const p = data!.p;
  // La guarda de verdad está en la RPC; esto es para no hacerle perder el tiempo
  // a alguien cargando cambios que el servidor va a rechazar igual.
  if (p.estado !== "ABIERTO") {
    return (
      <div className="space-y-4">
        <PageHeader title={`Presupuesto ${p.numero}`} />
        <SectionCard>
          <p className="text-sm">
            {p.estado === "CONVERTIDO"
              ? "Este presupuesto ya se convirtió en una venta, así que no se puede editar. Para cambiarlo hay que anular la venta."
              : "Este presupuesto está anulado. Hacé uno nuevo."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => navigate({ to: "/presupuestos/$id", params: { id } })}
          >
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver al presupuesto
          </Button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Editar ${p.numero}`}
        subtitle="Sigue siendo el mismo presupuesto: no cambia de número."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: "/presupuestos/$id", params: { id } })}
              disabled={m.isPending}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button
              onClick={() => m.mutate()}
              disabled={m.isPending || filas.length === 0}
              data-testid="guardar-edicion"
            >
              {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar cambios
            </Button>
          </>
        }
      />

      {/* Sólo aparece si algo se movió de verdad. Un cartel permanente se vuelve
          parte del decorado y deja de leerse. */}
      {movidas.length > 0 && (
        <SectionCard>
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <p className="text-sm">
              <strong>
                {movidas.length} {movidas.length === 1 ? "producto cambió" : "productos cambiaron"}{" "}
                de precio
              </strong>{" "}
              desde que se hizo este presupuesto.{" "}
              {repreciar
                ? "Se van a guardar con el precio de HOY."
                : "Se conservan los precios presupuestados."}
            </p>
            <Button
              variant={repreciar ? "default" : "outline"}
              size="sm"
              onClick={() => setRepreciar((v) => !v)}
              data-testid="repreciar"
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {repreciar
                ? "Volver a los precios presupuestados"
                : "Actualizar a los precios de hoy"}
            </Button>
          </div>
        </SectionCard>
      )}

      <SectionCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label>Sucursal</Label>
            {/* No se cambia: el número del presupuesto sale de la serie de su
                sucursal, y moverlo dejaría un número que no corresponde. */}
            <Input value={(p as any).sucursal?.nombre ?? ""} disabled />
          </div>
          <div>
            <Label>
              Cliente <span className="text-xs text-muted-foreground">(si ya está cargado)</span>
            </Label>
            <ClientePicker
              value={clienteId}
              onChange={setClienteId}
              testId="presup-cliente"
              placeholder="— (todavía no)"
              permitirVacio
            />
          </div>
          <div>
            <Label>
              O el nombre suelto{" "}
              <span className="text-xs text-muted-foreground">(para cualquier cliente)</span>
            </Label>
            <Input value={nombreCliente} onChange={(e) => setNombreCliente(e.target.value)} />
          </div>
          <div>
            <Label>
              Válido hasta <span className="text-xs text-muted-foreground">(opcional)</span>
            </Label>
            <Input type="date" value={validez} onChange={(e) => setValidez(e.target.value)} />
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <Label>Agregar otro producto</Label>
        <div className="relative max-w-xl">
          <Search className="h-4 w-4 absolute left-2 top-3 text-muted-foreground" />
          <Input
            className="pl-8"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Ej: 4000-00400 o membrana"
            data-testid="buscar-producto-presup"
          />
          {isFetching && <Loader2 className="h-4 w-4 animate-spin absolute right-2 top-3" />}
        </div>
        {busqueda.trim().length >= 2 && resultados.length > 0 && (
          <div
            /* Alto en vh: max-h-56 mostraba ~6 filas y con 161 resultados era
               imposible recorrerlos. */
            className="rounded-lg border border-border max-h-[min(50vh,24rem)] overflow-auto mt-2"
          >
            {resultados.map((r: any) => (
              <button
                key={r.id}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex gap-3"
                onClick={() => agregar(r)}
              >
                <span className="font-mono text-xs w-32 shrink-0">{r.codigo}</span>
                <span className="truncate flex-1">{r.nombre}</span>
                <span className="font-mono text-xs">
                  {fmtMoney(conIva(r.precio_sin_iva, r.iva_porcentaje))}
                </span>
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="rounded-2xl border border-border overflow-hidden shadow-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="text-right">Cant.</TableHead>
                <TableHead className="text-right">Precio de lista</TableHead>
                <TableHead className="text-right">Desc. %</TableHead>
                <TableHead className="text-right">Precio final</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    No quedó ningún producto. Agregá uno o volvé sin guardar.
                  </TableCell>
                </TableRow>
              ) : (
                filas.map((f) => {
                  const base = precioDe(f, repreciar);
                  const precio = +(base * (1 - Number(f.descuento || 0) / 100)).toFixed(2);
                  // Sólo si el precio que se está mostrando NO es el de hoy.
                  // Repreciando serían el mismo número dos veces.
                  const seMovio = !repreciar && f.precio_snapshot !== null && base !== f.precio_hoy;
                  // Se muestra con IVA, igual que en el presupuesto que ve el
                  // cliente. Lo que se guarda sigue siendo el neto.
                  const iva = ivaDe(f, repreciar);
                  const precioFinal = conIva(precio, iva);
                  const precioListaFinal = conIva(base, iva);
                  const subtotalFinal = calcularTotales([
                    {
                      cantidad: Number(f.cantidad || 0),
                      precio_unitario_sin_iva: precio,
                      descuento_porcentaje: 0,
                      iva_porcentaje: iva,
                    },
                  ]).total;
                  return (
                    <TableRow key={f.producto_id} data-testid="fila-presupuesto">
                      <TableCell className="font-mono text-xs">{f.codigo}</TableCell>
                      <TableCell>
                        {f.nombre}
                        {f.precio_snapshot === null && (
                          <span className="ml-2 text-[10px] text-muted-foreground">(nuevo)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <NumberInput
                          className="max-w-20 ml-auto"
                          value={f.cantidad}
                          onValueChange={(v) => upd(f.producto_id, { cantidad: v })}
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {fmtMoney(precioListaFinal)}
                        {seMovio && (
                          <span className="block text-[10px]">
                            hoy vale {fmtMoney(conIva(f.precio_hoy, f.iva_hoy))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <NumberInput
                          className="max-w-20 ml-auto"
                          value={f.descuento}
                          onValueChange={(v) =>
                            upd(f.producto_id, { descuento: Math.min(Math.max(v ?? 0, 0), 100) })
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs font-medium">
                        {fmtMoney(precioFinal)}
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {fmtMoney(subtotalFinal)}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => borrar(f.producto_id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Observaciones" className="lg:col-span-2">
          <Textarea
            value={observaciones}
            onChange={(e) => setObservaciones(e.target.value)}
            placeholder="Lo que quieras que salga en el presupuesto…"
          />
        </SectionCard>
        <SectionCard title="Total">
          <div className="space-y-1 text-sm">
            <div className="flex items-baseline justify-between text-lg font-bold">
              <span>TOTAL:</span>
              <span className="font-mono">{fmtMoney(totales.total)}</span>
            </div>
            {p.total != null && Number(p.total) !== totales.total && (
              <p className="text-xs text-muted-foreground pt-1">
                Antes era {fmtMoney(Number(p.total))}.
              </p>
            )}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
