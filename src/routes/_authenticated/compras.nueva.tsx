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
import { Textarea } from "@/components/ui/textarea";
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
import { fmtMoney, formaPagoLabel } from "@/lib/format";
import { Trash2, Plus, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/compras/nueva")({
  component: NuevaCompra,
});

interface ItemRow {
  producto_id: string;
  codigo: string;
  descripcion: string;
  cantidad: number;
  costo_unitario_sin_iva: number | null;
  iva_porcentaje: number;
}
interface PagoRow {
  id: string;
  forma_pago: string;
  monto: number;
  detalle: Record<string, any>;
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

function NuevaCompra() {
  const { data: cu } = useCurrentUser();
  const navigate = useNavigate();

  const [sucursalId, setSucursalId] = useState("");
  const [proveedorId, setProveedorId] = useState("");
  const [provQuery, setProvQuery] = useState("");
  const [tipoComp, setTipoComp] = useState("FACTURA_A");
  const [numero, setNumero] = useState("");
  const [fechaComp, setFechaComp] = useState(hoyISO());
  const [fechaVto, setFechaVto] = useState("");
  const [condicion, setCondicion] = useState<"CONTADO" | "CTA_CTE">("CONTADO");
  const [percepciones, setPercepciones] = useState<number | null>(0);
  const [observaciones, setObservaciones] = useState("");
  const [subtotal, setSubtotal] = useState<number | null>(null);
  const [ivaTotal, setIvaTotal] = useState<number | null>(null);
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [showProv, setShowProv] = useState(false);

  const effSucursal = sucursalId || cu?.sucursal?.id || "";
  const esCtaCte = condicion === "CTA_CTE";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const { data: proveedores = [] } = useQuery({
    queryKey: ["prov-search", provQuery],
    queryFn: async () => {
      let q = supabase
        .from("proveedores")
        .select("id,razon_social,cuit_dni,condicion_cta_cte")
        .eq("activo", true)
        .limit(15);
      if (provQuery) q = q.or(`razon_social.ilike.%${provQuery}%,cuit_dni.ilike.%${provQuery}%`);
      return ((await q).data ?? []) as any[];
    },
  });
  const provSel = useMemo(
    () => proveedores.find((p: any) => p.id === proveedorId),
    [proveedores, proveedorId],
  );

  const totales = useMemo(() => {
    const r2 = (n: number) => +n.toFixed(2);
    const sub = r2(Number(subtotal || 0));
    const iva = r2(Number(ivaTotal || 0));
    const total = r2(sub + iva + r2(Number(percepciones || 0)));
    const pagado = esCtaCte
      ? 0
      : pagos.reduce((a: number, p: any) => a + r2(Number(p.monto || 0)), 0);
    return { sub, iva, total, pagado, saldo: total - pagado };
  }, [subtotal, ivaTotal, percepciones, pagos, esCtaCte]);

  useEffect(() => {
    if (esCtaCte && pagos.length) setPagos([]);
  }, [esCtaCte, pagos.length]);

  const addPago = () =>
    setPagos((p) => [
      ...p,
      {
        id: crypto.randomUUID(),
        forma_pago: "EFECTIVO",
        monto: Math.max(0, totales.saldo),
        detalle: {},
      },
    ]);
  const updPago = (id: string, k: string, v: any) =>
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const updPagoDet = (id: string, k: string, v: any) =>
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, detalle: { ...x.detalle, [k]: v } } : x)));
  const rmPago = (id: string) => setPagos((p) => p.filter((x) => x.id !== id));

  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("crear_compra", {
        p_proveedor_id: proveedorId,
        p_sucursal_id: effSucursal,
        p_tipo_comprobante: tipoComp,
        p_numero: numero.trim(),
        p_fecha_comprobante: fechaComp,
        p_fecha_vencimiento: (fechaVto || null) as any,
        p_subtotal_sin_iva: Number(subtotal || 0),
        p_iva_total: Number(ivaTotal || 0),
        p_pagos: esCtaCte
          ? []
          : pagos
              .filter((p) => Number(p.monto || 0) > 0)
              .map((p) => ({
                forma_pago: p.forma_pago,
                monto: Number(p.monto),
                detalle: p.detalle,
              })),
        p_percepciones: Number(percepciones || 0),
        p_condicion: condicion,
        p_observaciones: observaciones || undefined,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Compra registrada");
      navigate({ to: "/compras" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const pagosOk = esCtaCte || Math.abs(totales.pagado - totales.total) <= 0.01;
  const canSave =
    !!effSucursal &&
    !!proveedorId &&
    !!numero.trim() &&
    !!fechaComp &&
    totales.total > 0 &&
    pagosOk;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nueva compra"
        subtitle="Registrá cuánta plata se le debe al proveedor"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/compras" })}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button onClick={() => m.mutate()} disabled={!canSave || m.isPending}>
              {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar
            </Button>
          </>
        }
      />

      {/* La pantalla tiene que decir qué NO hace. Es la misma lección que dejó el
          episodio del envase cargado como stock: el cartel de la importación
          existe por eso. Acá el riesgo es al revés — que alguien cargue la
          factura esperando que la mercadería entre sola. */}
      <SectionCard>
        <p className="text-sm text-muted-foreground">
          Esto registra <strong>la plata que se le debe al proveedor</strong>.{" "}
          <strong>No suma stock</strong>: la mercadería se carga en{" "}
          <strong>Ingresos de mercadería</strong>, buscando cada producto y poniendo cuánto entró.
        </p>
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Datos del comprobante" className="lg:col-span-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Sucursal *</Label>
              {cu?.isAdmin ? (
                <Select value={sucursalId} onValueChange={setSucursalId}>
                  <SelectTrigger>
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
              <Popover open={showProv} onOpenChange={setShowProv}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start truncate">
                    {provSel ? provSel.razon_social : "Buscar proveedor…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[92vw] sm:w-[400px] p-2">
                  <Input
                    placeholder="Nombre o CUIT…"
                    value={provQuery}
                    onChange={(e) => setProvQuery(e.target.value)}
                    autoFocus
                  />
                  <div className="max-h-64 overflow-auto mt-2">
                    {proveedores.map((p: any) => (
                      <button
                        key={p.id}
                        className="w-full text-left p-2 hover:bg-accent rounded text-sm"
                        onClick={() => {
                          setProveedorId(p.id);
                          setShowProv(false);
                        }}
                      >
                        <div className="font-medium flex items-center gap-2">
                          {p.razon_social}
                          {p.condicion_cta_cte && (
                            <Badge variant="outline" className="text-[10px]">
                              Cta Cte
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">{p.cuit_dni ?? "—"}</div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <Label>Tipo *</Label>
              <Select value={tipoComp} onValueChange={setTipoComp}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FACTURA_A">Factura A</SelectItem>
                  <SelectItem value="FACTURA_B">Factura B</SelectItem>
                  <SelectItem value="FACTURA_C">Factura C</SelectItem>
                  <SelectItem value="REMITO">Remito</SelectItem>
                  <SelectItem value="OTRO">Otro</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>N° de comprobante *</Label>
              <Input
                value={numero}
                onChange={(e) => setNumero(e.target.value)}
                placeholder="0001-00001234"
              />
            </div>
            <div>
              <Label>Fecha del comprobante *</Label>
              <Input type="date" value={fechaComp} onChange={(e) => setFechaComp(e.target.value)} />
            </div>
            <div>
              <Label>Vencimiento (opcional)</Label>
              <Input type="date" value={fechaVto} onChange={(e) => setFechaVto(e.target.value)} />
            </div>
            <div>
              <Label>Condición *</Label>
              <Select value={condicion} onValueChange={(v) => setCondicion(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE" disabled={!provSel?.condicion_cta_cte}>
                    Cuenta Corriente
                  </SelectItem>
                </SelectContent>
              </Select>
              {esCtaCte && (
                <p className="text-[11px] text-warning mt-1">Queda como deuda con el proveedor.</p>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Totales">
          <div className="space-y-1 text-sm">
            {/* Se escriben mirando la factura. Antes salían de sumar los ítems;
                sin ítems, los pone la persona — que es lo que hace igual con la
                calculadora. El IVA va suelto y no derivado de un porcentaje único:
                en una factura real conviven alícuotas distintas y percepciones, y
                recomponerlo sería inventar un número que no está en el papel. */}
            <div className="flex justify-between items-center gap-2">
              <Label className="text-sm m-0">Subtotal s/IVA:</Label>
              <NumberInput
                value={subtotal}
                onValueChange={setSubtotal}
                className="h-7 w-32 text-right"
                data-testid="compra-subtotal"
              />
            </div>
            <div className="flex justify-between items-center gap-2">
              <Label className="text-sm m-0">IVA:</Label>
              <NumberInput
                value={ivaTotal}
                onValueChange={setIvaTotal}
                className="h-7 w-32 text-right"
                data-testid="compra-iva"
              />
            </div>
            <div className="flex justify-between items-center gap-2">
              <Label className="text-sm m-0">Percepciones:</Label>
              <NumberInput
                value={percepciones}
                onValueChange={setPercepciones}
                className="h-7 w-28 text-right"
              />
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
              <span>TOTAL:</span>
              <span className="font-mono">{fmtMoney(totales.total)}</span>
            </div>
            {!esCtaCte ? (
              <>
                <div className="flex justify-between text-success">
                  <span>A pagar:</span>
                  <span className="font-mono">{fmtMoney(totales.pagado)}</span>
                </div>
                {!pagosOk && (
                  <p className="text-[11px] text-destructive">
                    Los pagos deben cubrir exactamente el total.
                  </p>
                )}
              </>
            ) : (
              <div className="flex justify-between text-warning font-semibold border-t border-border pt-2">
                <span>Va a deuda:</span>
                <span className="font-mono">{fmtMoney(totales.total)}</span>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {!esCtaCte && (
        <SectionCard className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Formas de pago</h3>
            <Button size="sm" variant="outline" onClick={addPago}>
              <Plus className="h-4 w-4 mr-1" /> Agregar pago
            </Button>
          </div>
          {pagos.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Agregá cómo se pagó la compra (debe cubrir el total).
            </p>
          ) : (
            <div className="space-y-2">
              {pagos.map((p) => (
                <div
                  key={p.id}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end p-2 border border-border rounded"
                >
                  <div className="col-span-3">
                    <Label className="text-xs">Forma</Label>
                    <Select
                      value={p.forma_pago}
                      onValueChange={(v) => updPago(p.id, "forma_pago", v)}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* A un proveedor solo se le paga en efectivo, transferencia o cheque. */}
                        {["EFECTIVO", "TRANSFERENCIA", "CHEQUE"].map((k) => (
                          <SelectItem key={k} value={k}>
                            {formaPagoLabel[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Monto</Label>
                    <NumberInput
                      className="h-9"
                      value={p.monto}
                      onValueChange={(v) => updPago(p.id, "monto", v ?? 0)}
                    />
                  </div>
                  <div className="col-span-6">
                    {(p.forma_pago === "TRANSFERENCIA" || p.forma_pago === "CHEQUE") && (
                      <>
                        <Label className="text-xs">Banco / Detalle</Label>
                        <Input
                          className="h-9"
                          value={p.detalle.banco ?? ""}
                          onChange={(e) => updPagoDet(p.id, "banco", e.target.value)}
                        />
                      </>
                    )}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => rmPago(p.id)}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard>
        <Label>Observaciones</Label>
        <Textarea
          value={observaciones}
          onChange={(e) => setObservaciones(e.target.value)}
          rows={2}
          className="mt-1"
        />
      </SectionCard>
    </div>
  );
}
