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
import { uuidv4 } from "@/lib/uuid";
import {
  ALICUOTAS_COMPRA,
  calcularImporteCompra,
  faltanteCompra,
  modoIvaSugerido,
  paraRpc,
  redondearACentavos,
  type ModoIva,
} from "@/lib/compras-importe";

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
  /** Vacío = todavía no eligió. Nunca se adivina: la plata sale de la caja. */
  forma_pago: string;
  monto: number | null;
  detalle: Record<string, any>;
}

const hoyISO = () => new Date().toISOString().slice(0, 10);

/** Id fijo de la fila que se pre-carga sola: si cambiara en cada render, el
 *  input perdería el foco mientras se escribe el total. */
const ID_PAGO_AUTO = "pago-auto";

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
  // El dato que trae el papel es el TOTAL. El neto y el IVA se despejan de ahí.
  const [total, setTotal] = useState<number | null>(null);
  const [modoIva, setModoIva] = useState<ModoIva>(modoIvaSugerido("FACTURA_A"));
  const [tasaIva, setTasaIva] = useState<number>(21);
  const [ivaManual, setIvaManual] = useState<number | null>(null);
  const [ivaTocado, setIvaTocado] = useState(false);
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [pagosTocados, setPagosTocados] = useState(false);
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

  const importe = useMemo(
    () => calcularImporteCompra({ total, percepciones, modoIva, tasaIva, ivaManual }),
    [total, percepciones, modoIva, tasaIva, ivaManual],
  );

  const pagado = useMemo(
    () => (esCtaCte ? 0 : pagos.reduce((a, p) => a + Number(p.monto || 0), 0)),
    [pagos, esCtaCte],
  );

  // El desglose por defecto lo decide el TIPO de comprobante: una Factura A
  // discrimina IVA, una B/C o un remito no. Sin esto, el default único dejaría
  // cada Factura A guardada con iva_total en cero y el dato no serviría más.
  // Se pisa sólo mientras nadie tocó el control a mano.
  useEffect(() => {
    if (ivaTocado) return;
    setModoIva(modoIvaSugerido(tipoComp));
  }, [tipoComp, ivaTocado]);

  // Si el proveedor elegido no tiene cuenta corriente, la condición no puede
  // quedar en CTA_CTE: el <SelectItem> deshabilitado impide ELEGIRLA, no impide
  // que sobreviva de un proveedor anterior. Sin esto la pantalla oculta los
  // pagos y el rechazo llega recién del servidor.
  useEffect(() => {
    if (provSel && !provSel.condicion_cta_cte) setCondicion("CONTADO");
  }, [provSel]);

  // Una compra al contado se paga entera (lo exige la RPC), así que el monto del
  // pago es el total. Se pre-carga para no obligar a escribir dos veces el mismo
  // número — pero la FORMA queda vacía a propósito: acá sale plata de la caja de
  // verdad, y dejar "Efectivo" puesto de fábrica haría que apretar Guardar sin
  // mirar registre un egreso en efectivo de algo que quizás fue transferencia.
  //
  // La sincronización se corta apenas alguien toca un monto, agrega o borra una
  // fila: a partir de ahí manda la persona. Elegir la forma NO cuenta como
  // tocar el monto.
  useEffect(() => {
    if (esCtaCte || pagosTocados) return;
    setPagos((prev) => {
      // Con el total en cero se vacía el MONTO, no se borra la fila: borrarla
      // perdería la forma de pago ya elegida, y borrar el total para
      // reescribirlo es lo primero que hace cualquiera al corregir un número.
      const monto = importe.total > 0 ? importe.total : null;
      if (prev.length === 0) {
        return monto === null ? prev : [{ id: ID_PAGO_AUTO, forma_pago: "", monto, detalle: {} }];
      }
      if (prev.length === 1 && prev[0].monto === monto) return prev;
      return [{ ...prev[0], id: ID_PAGO_AUTO, monto }];
    });
  }, [esCtaCte, pagosTocados, importe.total]);

  const addPago = () => {
    setPagosTocados(true);
    setPagos((p) => [
      ...p,
      {
        // uuidv4() y no crypto.randomUUID(): esa API no existe fuera de contexto
        // seguro (entrar por IP de la red sobre http), y ahí "Agregar pago"
        // tiraba TypeError sin que pasara nada. Mismo bug que el conteo físico.
        id: uuidv4(),
        forma_pago: "",
        monto: Math.max(0, +(importe.total - pagado).toFixed(2)),
        detalle: {},
      },
    ]);
  };
  const updPago = (id: string, k: string, v: any) => {
    if (k === "monto") setPagosTocados(true);
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  };
  const updPagoDet = (id: string, k: string, v: any) =>
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, detalle: { ...x.detalle, [k]: v } } : x)));
  const rmPago = (id: string) => {
    setPagosTocados(true);
    setPagos((p) => p.filter((x) => x.id !== id));
  };

  const m = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc("crear_compra", {
        p_proveedor_id: proveedorId,
        p_sucursal_id: effSucursal,
        p_tipo_comprobante: tipoComp,
        p_numero: numero.trim(),
        p_fecha_comprobante: fechaComp,
        p_fecha_vencimiento: (fechaVto || null) as any,
        ...paraRpc(importe),
        // En cuenta corriente los pagos no se mandan, pero tampoco se borran del
        // formulario: si alguien prueba cambiar la condición y vuelve, no pierde
        // el detalle de la transferencia que ya había escrito.
        p_pagos: esCtaCte
          ? []
          : pagos
              .filter((p) => Number(p.monto || 0) > 0)
              .map((p) => ({
                forma_pago: p.forma_pago,
                monto: Number(p.monto),
                detalle: p.detalle,
              })),
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

  // Un solo lugar decide si se puede guardar Y por qué no. Antes eran un
  // booleano mudo y un cartel rojo que hablaba de los pagos aunque el problema
  // fuera otro: la clienta se quedó mirando un botón gris sin ninguna pista.
  const faltante = faltanteCompra({
    sucursalId: effSucursal,
    proveedorId,
    numero,
    fechaComprobante: fechaComp,
    importe,
    esCtaCte,
    pagos,
  });
  const canSave = faltante === null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nueva compra"
        subtitle="Registrá cuánta plata se le debe al proveedor"
        actions={
          <>
            {faltante && (
              <span
                className="text-xs text-muted-foreground max-w-[16rem] text-right leading-tight hidden sm:block"
                data-testid="compra-faltante"
              >
                {faltante}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/compras" })}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button
              onClick={() => m.mutate()}
              disabled={!canSave || m.isPending}
              title={faltante ?? "Guardar la compra"}
            >
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

        {/* El importe se carga como viene en el papel: el TOTAL primero, con el
            IVA adentro, y el desglose después. Antes se pedía "Subtotal s/IVA"
            en un input chiquito al costado, y la clienta no lo reconoció como
            campo: el total quedaba en cero y Guardar no se habilitaba nunca.
            Ver docs/superpowers/specs/2026-08-03-compras-importe-design.md */}
        <SectionCard title="Importe de la compra">
          <div className="space-y-3 text-sm">
            <div>
              <Label htmlFor="compra-total">Total del comprobante *</Label>
              <NumberInput
                id="compra-total"
                value={total}
                // Al centavo desde el vamos: si no, el campo podía quedar
                // mostrando "1.005" mientras el TOTAL y la base decían 1,01.
                onValueChange={(v) => setTotal(redondearACentavos(v))}
                className="h-11 text-lg text-right font-mono"
                placeholder="0,00"
                autoFocus
                data-testid="compra-total"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                El número final que dice la factura o el remito, con el IVA ya incluido.
              </p>
            </div>

            <div className="border-t border-border pt-3 space-y-2">
              <div>
                <Label className="text-xs">IVA incluido</Label>
                <Select
                  value={modoIva === "tasa" ? String(tasaIva) : modoIva}
                  onValueChange={(v) => {
                    setIvaTocado(true);
                    if (v === "sin" || v === "manual") setModoIva(v);
                    else {
                      setModoIva("tasa");
                      setTasaIva(Number(v));
                    }
                  }}
                >
                  <SelectTrigger className="h-9" data-testid="compra-modo-iva">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sin">Sin desglosar</SelectItem>
                    {ALICUOTAS_COMPRA.map((a) => (
                      <SelectItem key={a} value={String(a)}>
                        {String(a).replace(".", ",")}%
                      </SelectItem>
                    ))}
                    <SelectItem value="manual">Escribir el monto…</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {modoIva === "manual" && (
                <div className="flex justify-between items-center gap-2">
                  <Label className="text-xs m-0">Monto de IVA:</Label>
                  <NumberInput
                    value={ivaManual}
                    onValueChange={(v) => setIvaManual(redondearACentavos(v))}
                    className="h-8 w-32 text-right"
                    data-testid="compra-iva-manual"
                  />
                </div>
              )}

              <div className="flex justify-between items-center gap-2">
                <Label className="text-xs m-0">Percepciones:</Label>
                <NumberInput
                  value={percepciones}
                  onValueChange={setPercepciones}
                  className="h-8 w-32 text-right"
                  data-testid="compra-percepciones"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Percepciones de IVA o Ingresos Brutos que algunas facturas cobran aparte.{" "}
                <strong>Ya vienen sumadas en el total</strong>: si la factura no las trae, dejá 0.
              </p>
            </div>

            {importe.error && (
              <p className="text-xs text-destructive" data-testid="compra-error-importe">
                {importe.error}
              </p>
            )}

            <div className="border-t border-border pt-2 space-y-1 text-muted-foreground text-xs">
              <div className="flex justify-between">
                <span>Neto s/IVA:</span>
                <span className="font-mono" data-testid="compra-neto">
                  {fmtMoney(importe.neto)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>IVA:</span>
                <span className="font-mono" data-testid="compra-iva">
                  {fmtMoney(importe.iva)}
                </span>
              </div>
            </div>

            <div className="flex justify-between text-lg font-bold border-t border-border pt-2">
              <span>TOTAL:</span>
              <span className="font-mono" data-testid="compra-total-calculado">
                {fmtMoney(importe.total)}
              </span>
            </div>

            {esCtaCte ? (
              <div className="flex justify-between text-warning font-semibold">
                <span>Va a deuda:</span>
                <span className="font-mono">{fmtMoney(importe.total)}</span>
              </div>
            ) : (
              <div className="flex justify-between text-success">
                {/* Antes esta línea decía "A pagar" y mostraba lo YA cargado en
                    formas de pago. Con el total en cero afirmaba que había que
                    pagar $120.000 de una compra que valía $0. */}
                <span>Pagado:</span>
                <span className="font-mono" data-testid="compra-pagado">
                  {fmtMoney(pagado)}
                </span>
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
              Escribí primero el total; el pago se completa solo y sólo tenés que elegir con qué se
              pagó.
            </p>
          ) : (
            <div className="space-y-2">
              {pagos.map((p) => (
                <div
                  key={p.id}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end p-2 border border-border rounded"
                >
                  <div className="col-span-3">
                    <Label className="text-xs">Forma *</Label>
                    <Select
                      value={p.forma_pago}
                      onValueChange={(v) => updPago(p.id, "forma_pago", v)}
                    >
                      <SelectTrigger className="h-9" data-testid="pago-forma">
                        {/* Arranca vacío a propósito: de acá sale plata de la caja
                            y el sistema no adivina si fue efectivo o transferencia. */}
                        <SelectValue placeholder="Elegí…" />
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
                      onValueChange={(v) => updPago(p.id, "monto", redondearACentavos(v))}
                      data-testid="pago-monto"
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
