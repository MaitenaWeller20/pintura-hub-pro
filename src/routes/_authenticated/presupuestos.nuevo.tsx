import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/ui/number-input";
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
import { fmtMoney } from "@/lib/format";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Search, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/presupuestos/nuevo")({
  component: NuevoPresupuesto,
});

// Mismo layout que /ventas/nueva, que la empleada ya sabe usar: buscar producto,
// cantidad, descuento, total abajo. La diferencia es que esto NO descuenta stock
// ni cobra nada.

type Fila = {
  producto_id: string;
  codigo: string;
  nombre: string;
  precio_lista: number;
  iva: number;
  cantidad: number | null;
  descuento: number | null;
};

function NuevoPresupuesto() {
  const navigate = useNavigate();
  const { data: cu } = useCurrentUser();
  const [sucursalId, setSucursalId] = useState("");
  const [clienteId, setClienteId] = useState("");
  const [nombreCliente, setNombreCliente] = useState("");
  const [validez, setValidez] = useState("");
  const [observaciones, setObservaciones] = useState("");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [busqueda, setBusqueda] = useState("");

  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: sucursales = [] } = useQuery({
    queryKey: ["sucursales"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-activos"],
    queryFn: async () =>
      ((
        await supabase
          .from("clientes")
          .select("id, razon_social")
          .eq("activo", true)
          .order("razon_social")
          .limit(500)
      ).data ?? []) as any[],
  });

  const { data: resultados = [], isFetching } = useQuery({
    queryKey: ["buscar-prod-presupuesto", busqueda],
    enabled: busqueda.trim().length >= 2,
    queryFn: async () =>
      ((
        await supabase
          .from("productos")
          .select("id, codigo, nombre, precio_sin_iva, iva_porcentaje")
          .or(`codigo.ilike.%${busqueda.trim()}%,nombre.ilike.%${busqueda.trim()}%`)
          .eq("activo", true)
          .eq("archivado", false)
          .limit(10)
      ).data ?? []) as any[],
  });

  const agregar = (p: any) => {
    if (filas.some((f) => f.producto_id === p.id)) {
      toast.info("Ese producto ya está en el presupuesto.");
      return;
    }
    setFilas((prev) => [
      ...prev,
      {
        producto_id: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        precio_lista: Number(p.precio_sin_iva),
        iva: Number(p.iva_porcentaje),
        cantidad: 1,
        descuento: 0,
      },
    ]);
    setBusqueda("");
  };
  const upd = (id: string, patch: Partial<Fila>) =>
    setFilas((prev) => prev.map((f) => (f.producto_id === id ? { ...f, ...patch } : f)));
  const borrar = (id: string) => setFilas((prev) => prev.filter((f) => f.producto_id !== id));

  // Espejo del cálculo del servidor, sólo para mostrar el total mientras se carga.
  // El que manda es `crear_presupuesto`, que recalcula desde el catálogo.
  const totales = useMemo(() => {
    const r2 = (n: number) => +n.toFixed(2);
    let sub = 0,
      iva = 0;
    for (const f of filas) {
      const precio = r2(f.precio_lista * (1 - Number(f.descuento || 0) / 100));
      const si = r2(precio * Number(f.cantidad || 0));
      sub += si;
      iva += r2((si * f.iva) / 100);
    }
    return { sub: r2(sub), iva: r2(iva), total: r2(sub + iva) };
  }, [filas]);

  const m = useMutation({
    mutationFn: async () => {
      if (!effSucursal) throw new Error("Elegí la sucursal.");
      if (filas.length === 0) throw new Error("Agregá al menos un producto.");
      if (filas.some((f) => !(Number(f.cantidad) > 0)))
        throw new Error("Hay productos sin cantidad.");
      const { data, error } = await supabase.rpc("crear_presupuesto", {
        p_sucursal_id: effSucursal,
        p_items: filas.map((f) => ({
          producto_id: f.producto_id,
          cantidad: Number(f.cantidad),
          descuento_porcentaje: Number(f.descuento || 0),
        })) as any,
        p_cliente_id: clienteId || undefined,
        p_nombre_cliente: nombreCliente.trim() || undefined,
        p_validez_hasta: validez || undefined,
        p_observaciones: observaciones.trim() || undefined,
      });
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data[0] : data) as any;
    },
    onSuccess: (r: any) => {
      toast.success(`Presupuesto ${r?.numero ?? ""} guardado.`);
      navigate({ to: "/presupuestos" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nuevo presupuesto"
        subtitle="Precios para mandarle a un cliente. No descuenta stock ni cobra nada."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: "/presupuestos" })}
              disabled={m.isPending}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button onClick={() => m.mutate()} disabled={m.isPending || filas.length === 0}>
              {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar
            </Button>
          </>
        }
      />

      <SectionCard>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <Label>Sucursal *</Label>
            {cu.isAdmin ? (
              <Select value={effSucursal} onValueChange={setSucursalId}>
                <SelectTrigger data-testid="presup-sucursal">
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
            <Label>
              Cliente <span className="text-xs text-muted-foreground">(si ya está cargado)</span>
            </Label>
            <Select
              value={clienteId || "__none__"}
              onValueChange={(v) => setClienteId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">— (todavía no)</SelectItem>
                {clientes.map((c: any) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.razon_social}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>
              O el nombre suelto{" "}
              <span className="text-xs text-muted-foreground">(para cualquier cliente)</span>
            </Label>
            <Input
              value={nombreCliente}
              onChange={(e) => setNombreCliente(e.target.value)}
              data-testid="presup-nombre-cliente"
            />
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
        <Label>Buscar producto por código o nombre</Label>
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
          <div className="rounded-lg border border-border max-h-56 overflow-auto mt-2">
            {resultados.map((p: any) => (
              <button
                key={p.id}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm flex gap-3"
                onClick={() => agregar(p)}
              >
                <span className="font-mono text-xs w-32 shrink-0">{p.codigo}</span>
                <span className="truncate flex-1">{p.nombre}</span>
                <span className="font-mono text-xs">{fmtMoney(p.precio_sin_iva)}</span>
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
                <TableHead className="text-right">Precio</TableHead>
                <TableHead className="text-right">Cant.</TableHead>
                <TableHead className="text-right">Desc. %</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filas.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Buscá un producto arriba para agregarlo.
                  </TableCell>
                </TableRow>
              ) : (
                filas.map((f) => {
                  const precio = +(f.precio_lista * (1 - Number(f.descuento || 0) / 100)).toFixed(
                    2,
                  );
                  return (
                    <TableRow key={f.producto_id} data-testid="fila-presupuesto">
                      <TableCell className="font-mono text-xs">{f.codigo}</TableCell>
                      <TableCell>{f.nombre}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {fmtMoney(precio)}
                        {Number(f.descuento || 0) > 0 && (
                          <span className="block text-[10px] text-muted-foreground line-through">
                            {fmtMoney(f.precio_lista)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <NumberInput
                          className="max-w-20 ml-auto"
                          value={f.cantidad}
                          onValueChange={(v) => upd(f.producto_id, { cantidad: v })}
                        />
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
                      <TableCell className="text-right font-mono">
                        {fmtMoney(precio * Number(f.cantidad || 0))}
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
            <div className="flex justify-between">
              <span>Subtotal:</span>
              <span className="font-mono">{fmtMoney(totales.sub)}</span>
            </div>
            <div className="flex justify-between">
              <span>IVA:</span>
              <span className="font-mono">{fmtMoney(totales.iva)}</span>
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
              <span>TOTAL:</span>
              <span className="font-mono">{fmtMoney(totales.total)}</span>
            </div>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
