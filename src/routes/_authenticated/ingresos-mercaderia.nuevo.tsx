import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/ui/number-input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { extraerYMatchearRemito, buscarProductosIngreso } from "@/lib/ingresos.functions";
import { validarArchivo } from "@/lib/ingresos-ia";
import { ArrowLeft, Loader2, Upload, Search, Plus, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/ingresos-mercaderia/nuevo")({
  validateSearch: (s: Record<string, unknown>) => ({ id: (s.id as string) || undefined }),
  component: NuevoIngreso,
});

interface ItemRevision {
  linea: number;
  pagina: number;
  codigo_proveedor: string;
  descripcion_proveedor: string;
  cantidad: number | null;
  cantidad_raw: string;
  descripcion_raw: string;
  producto_id: string | null;
  codigo: string | null;
  descripcion: string | null;
  origen_match: "APRENDIDO" | "CODIGO" | "IA" | "MANUAL" | "NUEVO" | "IGNORADA";
  confianza: "ALTA" | "MEDIA" | "BAJA" | null;
  advertencia: string | null;
}

const ORIGEN_LABEL: Record<
  string,
  { txt: string; tone: "success" | "info" | "warning" | "neutral" }
> = {
  APRENDIDO: { txt: "Aprendido", tone: "success" },
  CODIGO: { txt: "Por código", tone: "success" },
  IA: { txt: "IA", tone: "info" },
  MANUAL: { txt: "A mano", tone: "neutral" },
  NUEVO: { txt: "Nuevo", tone: "warning" },
  IGNORADA: { txt: "Ignorada", tone: "neutral" },
};

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function NuevoIngreso() {
  const { data: cu } = useCurrentUser();
  const navigate = useNavigate();
  const { id: borradorId } = Route.useSearch();

  const [sucursalId, setSucursalId] = useState("");
  const [proveedorId, setProveedorId] = useState("");
  const [ingresoId, setIngresoId] = useState<string | null>(borradorId ?? null);
  const [numero, setNumero] = useState("");
  const [fecha, setFecha] = useState("");
  const [items, setItems] = useState<ItemRevision[]>([]);
  const [inconsistencia, setInconsistencia] = useState<string | null>(null);
  const [paginasQuitadas, setPaginasQuitadas] = useState<number[]>([]);
  const [esMock, setEsMock] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // Key estable por montaje (patrón de ventas.nueva): un reintento tras timeout
  // reusa la key y la RPC devuelve idempotente, en vez de errorear "ya confirmado".
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const { data: proveedores = [] } = useQuery({
    queryKey: ["prov-activos"],
    queryFn: async () =>
      ((
        await supabase
          .from("proveedores")
          .select("id,razon_social")
          .eq("activo", true)
          .order("razon_social")
      ).data ?? []) as any[],
  });

  // Retomar un borrador existente.
  useEffect(() => {
    if (!borradorId) return;
    (async () => {
      const { data: ing } = await supabase
        .from("ingresos_mercaderia")
        .select("*")
        .eq("id", borradorId)
        .maybeSingle();
      if (!ing) return;
      setProveedorId(ing.proveedor_id);
      setSucursalId(ing.sucursal_id);
      setNumero(ing.numero_remito_proveedor ?? "");
      setFecha(ing.fecha_remito ?? "");
      setInconsistencia(ing.bloqueo_confirmacion ?? null); // el bloqueo resiste el retomar
      setIngresoId(ing.id);
      const { data: its } = await supabase
        .from("ingreso_mercaderia_items")
        .select("*")
        .eq("ingreso_id", borradorId)
        .order("linea");
      setItems(
        (its ?? []).map((it: any) => ({
          linea: it.linea,
          pagina: it.pagina ?? 1,
          codigo_proveedor: it.codigo_proveedor ?? "",
          descripcion_proveedor: it.descripcion_proveedor ?? "",
          cantidad: it.cantidad,
          cantidad_raw: it.cantidad_raw ?? "",
          descripcion_raw: it.descripcion_raw ?? "",
          producto_id: it.producto_id,
          codigo: it.codigo,
          descripcion: it.descripcion,
          origen_match: it.origen_match,
          confianza: it.confianza,
          advertencia: it.advertencia,
        })),
      );
    })();
  }, [borradorId]);

  // Extraer + matchear. El server fn crea el borrador (rate limit), sube el
  // archivo y persiste todo; acá sólo mandamos el archivo y los ids.
  const extraerM = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Elegí un archivo.");
      if (!proveedorId) throw new Error("Elegí el proveedor.");
      if (!effSucursal) throw new Error("Elegí la sucursal.");
      // Validación client-side para feedback rápido (el server la repite igual).
      const errArchivo = validarArchivo(file.type, file.size);
      if (errArchivo) throw new Error(errArchivo);
      const b64 = await fileToBase64(file);
      return await extraerYMatchearRemito({
        data: {
          proveedor_id: proveedorId,
          sucursal_id: effSucursal,
          archivo_base64: b64,
          mime: file.type,
          filename: file.name,
        },
      });
    },
    onSuccess: (res) => {
      setIngresoId(res.ingreso_id);
      setItems(res.items as ItemRevision[]);
      setNumero(res.numero_remito ?? "");
      setFecha(res.fecha_remito ?? "");
      setInconsistencia(res.inconsistencia);
      setPaginasQuitadas(res.paginas_quitadas ?? []);
      setEsMock(res.mock);
      if (res.paginas_quitadas?.length)
        toast.info(`Se descartaron ${res.paginas_quitadas.length} página(s) duplicada(s).`);
      toast.success("Remito leído. Revisá las líneas.");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const updItem = (linea: number, patch: Partial<ItemRevision>) =>
    setItems((prev) => prev.map((it) => (it.linea === linea ? { ...it, ...patch } : it)));

  const totales = useMemo(() => {
    const activas = items.filter((it) => it.origen_match !== "IGNORADA");
    const conProducto = activas.filter((it) => it.producto_id && (it.cantidad ?? 0) > 0);
    return {
      activas: activas.length,
      listas: conProducto.length,
      sinResolver: activas.length - conProducto.length,
    };
  }, [items]);

  const confirmarM = useMutation({
    mutationFn: async () => {
      if (!ingresoId) throw new Error("Cargá el remito primero.");
      if (inconsistencia) throw new Error(inconsistencia);
      const payload = items.map((it) => ({
        linea: it.linea,
        producto_id: it.producto_id,
        codigo: it.codigo,
        descripcion: it.descripcion,
        cantidad: it.cantidad,
        codigo_proveedor: it.codigo_proveedor,
        descripcion_proveedor: it.descripcion_proveedor,
        cantidad_raw: it.cantidad_raw,
        descripcion_raw: it.descripcion_raw,
        pagina: it.pagina,
        origen_match: it.origen_match,
        confianza: it.confianza,
        aprender: it.origen_match !== "IGNORADA",
        pisar_equivalencia: false,
      }));
      const { error } = await supabase.rpc("confirmar_ingreso_mercaderia", {
        p_ingreso_id: ingresoId,
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

  const paso: "subir" | "revisar" = ingresoId && items.length ? "revisar" : "subir";
  const puedeConfirmar =
    paso === "revisar" && !inconsistencia && totales.listas > 0 && totales.sinResolver === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nuevo ingreso de mercadería"
        subtitle="Subí el remito del proveedor y el sistema lo lee solo"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: "/ingresos-mercaderia" })}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            {paso === "revisar" && (
              <Button
                onClick={() => confirmarM.mutate()}
                disabled={!puedeConfirmar || confirmarM.isPending}
                data-testid="confirmar-ingreso"
              >
                {confirmarM.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}{" "}
                Confirmar y sumar stock
              </Button>
            )}
          </>
        }
      />

      {esMock && (
        <div
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
          data-testid="mock-banner"
        >
          Modo demo: la extracción es simulada (no hay ANTHROPIC_API_KEY configurada). El circuito
          de stock es real.
        </div>
      )}

      {paso === "subir" && (
        <SectionCard title="El remito">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Sucursal *</Label>
              {cu?.isAdmin ? (
                <Select value={sucursalId} onValueChange={setSucursalId}>
                  <SelectTrigger data-testid="select-sucursal">
                    <SelectValue placeholder="Seleccionar…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sucs.map((s: any) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.nombre}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value={cu?.sucursal?.nombre ?? ""} disabled />
              )}
            </div>
            <div>
              <Label>Proveedor *</Label>
              <Select value={proveedorId} onValueChange={setProveedorId}>
                <SelectTrigger data-testid="select-proveedor">
                  <SelectValue placeholder="Seleccionar…" />
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
          </div>

          <div className="mt-4">
            <Label>Archivo del remito (PDF o foto)</Label>
            <label className="mt-1 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 cursor-pointer hover:bg-accent/50 transition">
              <Upload className="h-6 w-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {file ? file.name : "Elegí un PDF o una foto del remito"}
              </span>
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                className="hidden"
                data-testid="input-archivo"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <div className="mt-3 flex justify-end">
              <Button
                onClick={() => extraerM.mutate()}
                disabled={!file || !proveedorId || !effSucursal || extraerM.isPending}
                data-testid="btn-extraer"
              >
                {extraerM.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" /> Leyendo el remito…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4 mr-1" /> Leer remito
                  </>
                )}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}

      {paso === "revisar" && (
        <>
          {inconsistencia && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive flex gap-2 items-start"
              data-testid="inconsistencia"
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{inconsistencia}</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <SectionCard title="Datos del remito" className="lg:col-span-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>N° de remito del proveedor</Label>
                  <Input
                    value={numero}
                    onChange={(e) => setNumero(e.target.value)}
                    placeholder="00054-00023918"
                  />
                </div>
                <div>
                  <Label>Fecha del remito</Label>
                  <Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
                </div>
              </div>
              {paginasQuitadas.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Se descartaron {paginasQuitadas.length} página(s) duplicada(s):{" "}
                  {paginasQuitadas.join(", ")}.
                </p>
              )}
            </SectionCard>
            <SectionCard title="Resumen">
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span>Líneas:</span>
                  <span className="font-mono">{totales.activas}</span>
                </div>
                <div className="flex justify-between text-success">
                  <span>Con producto:</span>
                  <span className="font-mono">{totales.listas}</span>
                </div>
                {totales.sinResolver > 0 && (
                  <div className="flex justify-between text-destructive">
                    <span>Sin resolver:</span>
                    <span className="font-mono">{totales.sinResolver}</span>
                  </div>
                )}
                {totales.sinResolver > 0 && (
                  <p className="text-[11px] text-destructive pt-1">
                    Resolvé o ignorá todas las líneas antes de confirmar.
                  </p>
                )}
              </div>
            </SectionCard>
          </div>

          <SectionCard title="Líneas del remito" className="space-y-2">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Papel (código · descripción · cant.)</TableHead>
                    <TableHead>Producto</TableHead>
                    <TableHead>Cant.</TableHead>
                    <TableHead>Origen</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <ItemFila key={it.linea} it={it} onUpd={updItem} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </SectionCard>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Una fila de la grilla de revisión
// ---------------------------------------------------------------------------
function ItemFila({
  it,
  onUpd,
}: {
  it: ItemRevision;
  onUpd: (linea: number, patch: Partial<ItemRevision>) => void;
}) {
  const [buscar, setBuscar] = useState(false);
  const [q, setQ] = useState("");
  const [nuevo, setNuevo] = useState(false);
  const ignorada = it.origen_match === "IGNORADA";
  const badge = ORIGEN_LABEL[it.origen_match];

  const { data: candidatos = [] } = useQuery({
    queryKey: ["buscar-prod-ingreso", q],
    enabled: buscar && q.length >= 2,
    queryFn: async () =>
      await buscarProductosIngreso({
        data: { texto: q, codigo: it.codigo_proveedor || undefined },
      }),
  });

  return (
    <TableRow className={ignorada ? "opacity-40" : ""} data-testid={`fila-${it.linea}`}>
      <TableCell className="text-xs max-w-sm">
        <div className="font-mono">{it.codigo_proveedor || "—"}</div>
        <div className="text-muted-foreground truncate">
          {it.descripcion_raw || it.descripcion_proveedor}
        </div>
        {it.advertencia && (
          <div
            className="text-warning flex items-center gap-1 mt-0.5"
            data-testid={`adv-${it.linea}`}
          >
            <AlertTriangle className="h-3 w-3" /> {it.advertencia}
          </div>
        )}
      </TableCell>
      <TableCell className="text-sm">
        {it.producto_id ? (
          <div>
            <div className="font-medium">{it.descripcion}</div>
            <div className="text-xs font-mono text-muted-foreground">{it.codigo}</div>
          </div>
        ) : ignorada ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : (
          <span className="text-xs text-destructive">Sin producto</span>
        )}
      </TableCell>
      <TableCell>
        <NumberInput
          className="h-8 w-20"
          value={it.cantidad}
          onValueChange={(v) => onUpd(it.linea, { cantidad: v })}
          disabled={ignorada}
        />
      </TableCell>
      <TableCell>
        {badge && <StatusPill tone={badge.tone}>{badge.txt}</StatusPill>}
        {it.confianza && it.confianza !== "ALTA" && (
          <Badge variant="outline" className="ml-1 text-[10px]">
            {it.confianza}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1">
          {!ignorada && (
            <>
              <Popover open={buscar} onOpenChange={setBuscar}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Buscar otro producto"
                    data-testid={`buscar-${it.linea}`}
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[92vw] sm:w-[420px] p-2">
                  <Input
                    placeholder="Nombre o código…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    autoFocus
                  />
                  <div className="max-h-64 overflow-auto mt-2">
                    {candidatos.map((c: any) => (
                      <button
                        key={c.id}
                        className="w-full text-left p-2 hover:bg-accent rounded text-sm"
                        onClick={() => {
                          onUpd(it.linea, {
                            producto_id: c.id,
                            codigo: c.codigo,
                            descripcion: c.nombre,
                            origen_match: "MANUAL",
                            confianza: "ALTA",
                          });
                          setBuscar(false);
                        }}
                      >
                        <div className="font-medium">{c.nombre}</div>
                        <div className="text-xs font-mono text-muted-foreground">
                          {c.codigo}
                          {c.activo === false ? " · inactivo" : ""}
                        </div>
                      </button>
                    ))}
                    {q.length < 2 && (
                      <p className="text-xs text-muted-foreground p-2">
                        Escribí al menos 2 caracteres…
                      </p>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              <Button
                size="sm"
                variant="ghost"
                title="Crear producto nuevo"
                data-testid={`nuevo-${it.linea}`}
                onClick={() => setNuevo(true)}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            title={ignorada ? "Reincorporar" : "Ignorar línea"}
            data-testid={`ignorar-${it.linea}`}
            onClick={() => onUpd(it.linea, { origen_match: ignorada ? "MANUAL" : "IGNORADA" })}
          >
            <Trash2 className={`h-3.5 w-3.5 ${ignorada ? "" : "text-destructive"}`} />
          </Button>
        </div>
        {nuevo && (
          <DialogNuevoProducto
            it={it}
            onClose={() => setNuevo(false)}
            onCreado={(p) => {
              onUpd(it.linea, {
                producto_id: p.id,
                codigo: p.codigo,
                descripcion: p.nombre,
                origen_match: "NUEVO",
                confianza: "ALTA",
              });
              setNuevo(false);
            }}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Alta rápida de producto. Precio opcional: con precio nace activo y vendible;
// sin precio nace inactivo (oculto) hasta completarlo acá o en Productos.
// ---------------------------------------------------------------------------
function DialogNuevoProducto({
  it,
  onClose,
  onCreado,
}: {
  it: ItemRevision;
  onClose: () => void;
  onCreado: (p: any) => void;
}) {
  const [codigo, setCodigo] = useState(it.codigo_proveedor || "");
  const [nombre, setNombre] = useState(it.descripcion_proveedor || it.descripcion_raw || "");
  const [iva, setIva] = useState<number | null>(21);
  const [precio, setPrecio] = useState<number | null>(null);

  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("crear_producto_desde_ingreso", {
        p_codigo: codigo.trim(),
        p_nombre: nombre.trim(),
        p_iva: iva ?? 21,
        p_precio_sin_iva: precio && precio > 0 ? precio : undefined,
      });
      if (error) throw error;
      return { id: data as string, codigo: codigo.trim(), nombre: nombre.trim() };
    },
    onSuccess: (p) => {
      toast.success(
        precio && precio > 0
          ? "Producto creado y activo"
          : "Producto creado (inactivo hasta que le cargues el precio)",
      );
      onCreado(p);
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crear producto nuevo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Código *</Label>
            <Input
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              data-testid="nuevo-codigo"
            />
          </div>
          <div>
            <Label>Nombre *</Label>
            <Input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              data-testid="nuevo-nombre"
            />
          </div>
          <div className="flex gap-3">
            <div>
              <Label>IVA %</Label>
              <NumberInput value={iva} onValueChange={setIva} className="w-24" />
            </div>
            <div className="flex-1">
              <Label>Precio de venta s/IVA (opcional)</Label>
              <NumberInput
                value={precio}
                onValueChange={setPrecio}
                className="w-full"
                data-testid="nuevo-precio"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {precio && precio > 0 ? (
              <>
                Nace <strong>activo</strong>: entra al stock y ya se puede vender.
              </>
            ) : (
              <>
                Sin precio nace <strong>inactivo</strong>: entra al stock pero no se ve ni se vende
                hasta que le cargues el precio (acá o después en Productos).
              </>
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={!codigo.trim() || !nombre.trim() || m.isPending}
            data-testid="nuevo-crear"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
