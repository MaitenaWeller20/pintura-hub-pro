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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { NumberInput } from "@/components/ui/number-input";
import { fmtMoney, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { Trash2, Plus, ArrowLeft, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearVenta } from "@/lib/ventas.functions";
import { calcTotalesComprobante } from "@/lib/ventas-totales";
import { round2 } from "@/lib/fiscal/iva";

export const Route = createFileRoute("/_authenticated/ventas/nueva")({
  component: NuevaVenta,
});

interface ItemRow {
  producto_id: string;
  codigo: string;
  descripcion: string;
  cantidad: number;
  // null = "usá el precio de lista". Vacío en el input NO es 0.
  precio_unitario_sin_iva: number | null;
  iva_porcentaje: number;
  descuento_porcentaje: number;
  stock_disponible?: number;
  // Precio de catálogo al momento de agregar el producto. Sirve para saber si el
  // cajero pisó el precio: sólo en ese caso se lo mandamos al servidor. Si no, el
  // servidor lo resuelve solo contra el catálogo y no confía en el navegador.
  precio_lista: number;
  // R4/R5: la línea vino precargada de la factura que rectifica una NC/ND. En ese
  // caso SIEMPRE mandamos el precio facturado (histórico), aunque coincida con el
  // de lista, para que la nota espeje la factura y no el precio de hoy.
  desde_factura?: boolean;
}
interface PagoRow {
  id: string;
  forma_pago: string;
  monto: number;
  detalle: Record<string, any>;
}

// Tipos de comprobante que van a Cuenta Corriente del cliente (no impactan caja).
// R2.a: la "Factura interna" YA NO está acá — es un documento interno de contado.
const TIPOS_CTA_CTE = new Set(["REMITO", "REMITO_OBRA"]);

function NuevaVenta() {
  const { data: cu } = useCurrentUser();
  const navigate = useNavigate();
  const crear = useServerFn(crearVenta);

  const [sucursalId, setSucursalId] = useState<string>("");
  const [clienteId, setClienteId] = useState<string>("");
  const [clienteQuery, setClienteQuery] = useState("");
  const [tipoComp, setTipoComp] = useState<string>("FACTURA_B");
  const [condVenta, setCondVenta] = useState<"CONTADO" | "CTA_CTE">("CONTADO");
  const [percepciones, setPercepciones] = useState<number | null>(0);
  const [observaciones, setObservaciones] = useState("");
  const [nombreObra, setNombreObra] = useState("");
  // R5: recargo de una Nota de Débito (% sobre el total con IVA de la factura + monto fijo).
  const [recargoPct, setRecargoPct] = useState<number | null>(null);
  const [recargoMonto, setRecargoMonto] = useState<number | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [pagos, setPagos] = useState<PagoRow[]>([]);
  const [prodQuery, setProdQuery] = useState("");
  const [showCli, setShowCli] = useState(false);
  const [showProd, setShowProd] = useState(false);
  // Una key estable por vida del formulario: reintentar el mismo submit no duplica
  // la venta. Si el submit falla por validación, la venta no se creó y el reintento
  // procede normal; sólo hace short-circuit cuando la venta realmente quedó guardada.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // R2.a: la Factura interna es SIEMPRE de contado (nunca cuenta corriente).
  const esFacInterna = tipoComp === "FAC_INTERNA_CTA_CTE";
  const esCtaCte = (TIPOS_CTA_CTE.has(tipoComp) || condVenta === "CTA_CTE") && !esFacInterna;
  const esRemitoObra = tipoComp === "REMITO_OBRA";

  // R2.b: condición de IVA del emisor. Si es Monotributo, la única factura que
  // puede emitir es la C (la matriz A/B requiere emisor Responsable Inscripto).
  const { data: condicionEmisor } = useQuery({
    queryKey: ["condicion-emisor"],
    queryFn: async () => {
      const { data } = await supabase.rpc("condicion_iva_emisor");
      return (data ?? "RESPONSABLE_INSCRIPTO") as string;
    },
  });
  const emisorMonotributo = condicionEmisor === "MONOTRIBUTO";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-search", clienteQuery],
    queryFn: async () => {
      let q = supabase.from("clientes").select("id,razon_social,cuit_dni,tipo,condicion_cta_cte").eq("activo", true).limit(15);
      if (clienteQuery) q = q.or(`razon_social.ilike.%${clienteQuery}%,cuit_dni.ilike.%${clienteQuery}%`);
      return (((await q).data) ?? []) as any[];
    },
  });
  const clienteSel = useMemo(() => clientes.find((c: any) => c.id === clienteId), [clientes, clienteId]);

  // Traemos TODOS los productos activos una sola vez (el catálogo es chico) y
  // filtramos en el cliente: así el picker muestra la lista completa apenas se
  // abre y filtra al instante mientras escribís, sin un round-trip por tecla.
  const { data: productosCatalogo = [] } = useQuery({
    queryKey: ["prods-catalogo"],
    queryFn: async () => {
      const { data } = await supabase.from("productos")
        .select("id,codigo,nombre,precio_sin_iva,iva_porcentaje,stock_sucursal(cantidad,sucursal_id)")
        .eq("activo", true).order("nombre");
      return (data ?? []) as any[];
    },
  });

  const productosBusqueda = useMemo(() => {
    const q = prodQuery.trim().toLowerCase();
    if (!q) return productosCatalogo;
    return productosCatalogo.filter((p: any) =>
      p.codigo?.toLowerCase().includes(q) || p.nombre?.toLowerCase().includes(q),
    );
  }, [productosCatalogo, prodQuery]);

  const addProducto = (p: any) => {
    const stock = (p.stock_sucursal as any[])?.find((s) => s.sucursal_id === effSucursal)?.cantidad ?? 0;
    setItems(prev => [...prev, {
      producto_id: p.id, codigo: p.codigo, descripcion: p.nombre,
      cantidad: 1, precio_unitario_sin_iva: Number(p.precio_sin_iva),
      precio_lista: Number(p.precio_sin_iva),
      iva_porcentaje: Number(p.iva_porcentaje), descuento_porcentaje: 0,
      stock_disponible: Number(stock),
    }]);
    setProdQuery(""); setShowProd(false);
  };

  const updateItem = (i: number, k: keyof ItemRow, v: any) => {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, [k]: v } : it));
  };
  const removeItem = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i));

  // R4/R5: al elegir la factura que rectifica una NC/ND, se cargan SUS productos en
  // la grilla (editables y borrables: se devuelve/re-cobra sólo lo que corresponda).
  // El precio se toma histórico de la factura (desde_factura fuerza su envío).
  const seleccionarFacturaRectifica = async (facturaId: string) => {
    setCbteAsocId(facturaId);
    if (!facturaId) return;
    // La Nota de Débito NO trae productos: usa el recargo (R5). Sólo la NC precarga.
    if (tipoComp !== "NOTA_CREDITO") return;
    const { data, error } = await supabase.from("venta_items")
      .select("producto_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,iva_porcentaje,descuento_porcentaje")
      .eq("venta_id", facturaId);
    if (error) { toast.error("No se pudieron cargar los productos de la factura"); return; }
    setItems((data ?? []).map((it: any) => ({
      producto_id: it.producto_id,
      codigo: it.codigo,
      descripcion: it.descripcion,
      cantidad: Number(it.cantidad),
      precio_unitario_sin_iva: Number(it.precio_unitario_sin_iva),
      precio_lista: Number(it.precio_unitario_sin_iva),
      iva_porcentaje: Number(it.iva_porcentaje),
      descuento_porcentaje: Number(it.descuento_porcentaje ?? 0),
      desde_factura: true,
    })));
    toast.info("Se cargaron los productos de la factura. Editá o borrá los que no correspondan.");
  };

  // Una nota de crédito RESTA (es una devolución). Lo mostramos con el mismo signo
  // con el que se va a guardar, así el cajero ve lo que realmente va a pasar.
  const esNotaCredito = tipoComp === "NOTA_CREDITO";
  const esNotaDebito = tipoComp === "NOTA_DEBITO";
  const esNota = tipoComp === "NOTA_CREDITO" || tipoComp === "NOTA_DEBITO";
  const esFiscal = ["FACTURA_A", "FACTURA_B", "FACTURA_C", "NOTA_CREDITO", "NOTA_DEBITO"].includes(tipoComp);
  // Coherencia comprobante ↔ condición IVA: Factura A sólo a Responsable Inscripto.
  const comboInvalido =
    tipoComp === "FACTURA_A" && !!clienteSel && clienteSel.tipo !== "RESPONSABLE_INSCRIPTO";
  const signo = esNotaCredito ? -1 : 1;

  // Una nota de crédito/débito rectifica una factura concreta. AFIP lo exige
  // (CbtesAsoc) y sin eso la nota no se puede emitir.
  const [cbteAsocId, setCbteAsocId] = useState<string>("");
  const { data: facturasDelCliente = [] } = useQuery({
    queryKey: ["facturas-cliente", clienteId],
    enabled: esNota && !!clienteId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ventas")
        .select("id, numero_comprobante, tipo_comprobante, fecha, total")
        .eq("cliente_id", clienteId)
        .in("tipo_comprobante", ["FACTURA_A", "FACTURA_B", "FACTURA_C"])
        .eq("estado", "ACTIVA")
        .order("fecha", { ascending: false })
        .limit(30);
      return (data ?? []) as any[];
    },
  });

  // R5: la Nota de Débito NO trae productos. Es un recargo (interés/mora) sobre la
  // factura que rectifica: % sobre el total con IVA + un monto fijo. Se materializa
  // como UNA línea de concepto libre con IVA 21% (el server la desglosa en neto+IVA).
  const facturaSel = useMemo(
    () => facturasDelCliente.find((f: any) => f.id === cbteAsocId),
    [facturasDelCliente, cbteAsocId],
  );
  const recargoConIVA = useMemo(() => {
    if (!esNotaDebito) return 0;
    const base = Number(facturaSel?.total ?? 0);
    return round2(round2(base * (Number(recargoPct) || 0) / 100) + (Number(recargoMonto) || 0));
  }, [esNotaDebito, facturaSel, recargoPct, recargoMonto]);
  // Neto de la línea de recargo: el recargo es "con IVA", así el total de la ND
  // coincide con lo que ve el usuario (± redondeo). IVA 21%.
  const recargoNeto = useMemo(() => round2(recargoConIVA / 1.21), [recargoConIVA]);

  const totales = useMemo(() => {
    // R5: la ND se calcula sobre la línea de recargo, no sobre la grilla de productos.
    // Misma fórmula que la RPC (redondeo del IVA POR LÍNEA): así el total que ve el
    // cajero coincide al centavo con el del servidor y un pago electrónico "por el
    // total" no queda 1 centavo por encima. Ver R3/R5.
    const itemsCalc = esNotaDebito
      ? [{ precio_unitario_sin_iva: recargoNeto, precio_lista: recargoNeto, cantidad: 1, descuento_porcentaje: 0, iva_porcentaje: 21 }]
      : items;
    const { sub, iva, total } = calcTotalesComprobante(itemsCalc, percepciones, signo);
    const pagado = esCtaCte ? 0 : round2(pagos.reduce((a, p) => a + Number(p.monto || 0), 0)) * signo;
    return { sub, iva, total, pagado, saldo: round2(total - pagado) };
  }, [items, percepciones, pagos, esCtaCte, signo, esNotaDebito, recargoNeto]);

  // Cuenta Cte: limpio pagos al cambiar de tipo
  useEffect(() => {
    if (esCtaCte && pagos.length) setPagos([]);
  }, [esCtaCte, pagos.length]);

  // Al cambiar de cliente, limpio lo que era específico del cliente anterior: la
  // factura que rectifica una nota (no puede pertenecer a otro cliente) y el
  // nombre de obra tipeado para el borrador previo. Evita asociaciones cruzadas.
  useEffect(() => {
    setCbteAsocId("");
    setNombreObra("");
    // R4/R5: los productos precargados de una factura son de este cliente; al
    // cambiarlo, se quitan (los agregados a mano se conservan).
    setItems(prev => prev.some(it => it.desde_factura) ? prev.filter(it => !it.desde_factura) : prev);
  }, [clienteId]);

  // R4/R5: al dejar de ser nota (se cambió a una factura normal), se limpian los
  // productos precargados y la factura asociada. Si no, quedarían con el precio
  // HISTÓRICO pegado y se emitiría una factura cobrando un precio viejo sin aviso.
  useEffect(() => {
    if (!esNota) {
      setCbteAsocId("");
      setItems(prev => prev.some(it => it.desde_factura) ? prev.filter(it => !it.desde_factura) : prev);
    }
  }, [esNota]);

  // R5: al alternar entre NC y ND con la misma factura ya elegida, hay que
  // re-sincronizar la grilla: sólo la NC precarga los productos (la ND usa el
  // recargo). Sin esto, cambiar de ND a NC dejaba la grilla vacía y "Guardar"
  // deshabilitado sin aviso (el cliente no cambió y esNota sigue true).
  useEffect(() => {
    if (!esNota || !cbteAsocId) return;
    if (tipoComp === "NOTA_CREDITO") seleccionarFacturaRectifica(cbteAsocId);
    else setItems(prev => prev.filter(it => !it.desde_factura)); // ND: grilla limpia
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tipoComp]);

  // El comprobante por defecto tiene que reflejar la letra que le corresponde al
  // cliente: a un Responsable Inscripto le corresponde Factura A. El default global
  // es FACTURA_B (caso mostrador / consumidor final), así que al elegir un cliente
  // RI lo pasamos a A. Emitir B a un RI queda como una decisión EXPLÍCITA (el
  // operador cambia el selector a mano), nunca por omisión.
  useEffect(() => {
    if (esNota) return; // no tocar el tipo de una nota de crédito/débito
    // Emisor Monotributo -> la factura es siempre C (no existe A/B para él).
    if (emisorMonotributo) {
      if (tipoComp === "FACTURA_A" || tipoComp === "FACTURA_B") setTipoComp("FACTURA_C");
      return;
    }
    // Emisor Responsable Inscripto: la letra depende del cliente. Si venías de un
    // borrador con emisor Monotributo (C), lo bajamos a B.
    if (tipoComp === "FACTURA_C") { setTipoComp("FACTURA_B"); return; }
    const esRI = clienteSel?.tipo === "RESPONSABLE_INSCRIPTO";
    if (esRI && tipoComp === "FACTURA_B") setTipoComp("FACTURA_A");
    else if (!esRI && tipoComp === "FACTURA_A") setTipoComp("FACTURA_B");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clienteSel?.tipo, emisorMonotributo]);

  // R2.a: si se elige Factura interna con una condición de cuenta corriente
  // heredada de otro tipo, la reseteamos a contado (la Factura interna no va a Cta Cte).
  useEffect(() => {
    if (esFacInterna && condVenta === "CTA_CTE") setCondVenta("CONTADO");
  }, [esFacInterna, condVenta]);

  const addPago = () => setPagos(p => [...p, {
    id: crypto.randomUUID(),
    forma_pago: "EFECTIVO",
    // Por defecto, lo que falta cubrir. En una nota de crédito el saldo es
    // negativo (es una devolución), así que precargamos el importe a devolver:
    // el signo lo pone la base, el cajero siempre tipea un número positivo.
    monto: Math.abs(Math.min(0, totales.saldo)) || Math.max(0, totales.saldo),
    detalle: {},
  }]);
  const updPago = (id: string, k: string, v: any) => setPagos(p => p.map(x => x.id === id ? { ...x, [k]: v } : x));
  const updPagoDet = (id: string, k: string, v: any) => setPagos(p => p.map(x => x.id === id ? { ...x, detalle: { ...x.detalle, [k]: v } } : x));
  const rmPago = (id: string) => setPagos(p => p.filter(x => x.id !== id));

  const m = useMutation({
    mutationFn: async () => crear({
      data: {
        sucursal_id: effSucursal, cliente_id: clienteId,
        tipo_comprobante: tipoComp as any,
        condicion_venta: esCtaCte ? "CTA_CTE" : condVenta,
        percepciones: Number(percepciones || 0), observaciones,
        nombre_obra: esRemitoObra ? nombreObra : null,
        cbte_asoc_id: esNota ? cbteAsocId || null : null,
        idempotency_key: idempotencyKey,
        // R5: la Nota de Débito manda UNA línea de concepto libre (el recargo). El
        // resto de los comprobantes manda la grilla de productos.
        items: esNotaDebito
          ? [{
              producto_id: null,
              descripcion: `Recargo/interés s/ ${facturaSel?.numero_comprobante ?? ""}`.trim(),
              cantidad: 1,
              precio_unitario_sin_iva: recargoNeto,
              iva_porcentaje: 21,
              descuento_porcentaje: 0,
            }]
          : items.map((it) => {
          // Un campo de precio vacío (null) NO es "precio 0": es "usá el de lista".
          // Sólo mandamos el precio cuando el cajero tipeó un valor distinto al de
          // catálogo. Si no, el servidor lo resuelve solo.
          const precioTipeado =
            it.precio_unitario_sin_iva === null || it.precio_unitario_sin_iva === undefined
              ? null
              : Number(it.precio_unitario_sin_iva);
          // Un ítem precargado de la factura (NC) SIEMPRE manda su precio histórico,
          // aunque coincida con el de catálogo: la nota debe espejar la factura. El
          // forzado sólo aplica MIENTRAS sea una nota (defensa por si quedara un ítem
          // precargado tras cambiar de tipo; el efecto de arriba igual los limpia).
          const pisado =
            precioTipeado !== null &&
            ((esNota && it.desde_factura) || Math.abs(precioTipeado - Number(it.precio_lista || 0)) > 0.005);
          return {
            producto_id: it.producto_id,
            cantidad: Number(it.cantidad || 0),
            descuento_porcentaje: Number(it.descuento_porcentaje || 0),
            ...(pisado ? { precio_unitario_sin_iva: precioTipeado } : {}),
          };
        }),
        pagos: pagos
          .filter(p => Number(p.monto || 0) > 0)
          .map(p => ({ forma_pago: p.forma_pago as any, monto: Number(p.monto), detalle: p.detalle })),
      },
    }),
    onSuccess: (r: any) => {
      toast.success(`${tipoComprobanteLabel[tipoComp] ?? tipoComp} ${r.numero} registrado${r.cta_cte ? " (Cta Cte)" : ""}`);
      navigate({ to: "/ventas" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const canSave =
    !!effSucursal && !!clienteId &&
    // R5: la ND no usa la grilla; exige factura + un recargo > 0. El resto exige
    // al menos un ítem con cantidad > 0.
    (esNotaDebito
      ? (!!cbteAsocId && recargoConIVA > 0.005)
      : (items.length > 0 && items.some((it) => (it.cantidad || 0) > 0))) &&
    (!esFiscal || Math.abs(totales.total) > 0.005) &&
    // (1) no permitir Factura A a un cliente que no es Responsable Inscripto
    !comboInvalido &&
    (!esRemitoObra || nombreObra.trim().length > 0) &&
    // Una nota sin factura asociada no se puede emitir en AFIP.
    (!esNota || !!cbteAsocId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Nuevo comprobante"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/ventas" })}>
              <ArrowLeft className="h-4 w-4 mr-1" /> Volver
            </Button>
            <Button onClick={() => m.mutate()} disabled={!canSave || m.isPending}>
              {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Datos generales" className="lg:col-span-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Sucursal *</Label>
              {cu?.isAdmin ? (
                <Select value={sucursalId} onValueChange={setSucursalId}>
                  <SelectTrigger><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                  <SelectContent>{sucs.map((s: any) => (<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
                </Select>
              ) : <Input value={cu?.sucursal?.nombre ?? ""} disabled />}
            </div>
            <div>
              <Label>Tipo comprobante *</Label>
              <Select value={tipoComp} onValueChange={(v) => setTipoComp(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {emisorMonotributo ? (
                    <SelectItem value="FACTURA_C">Factura C</SelectItem>
                  ) : (
                    <>
                      <SelectItem value="FACTURA_A">Factura A</SelectItem>
                      <SelectItem value="FACTURA_B">Factura B</SelectItem>
                    </>
                  )}
                  <SelectItem value="NOTA_CREDITO">Nota de Crédito</SelectItem>
                  <SelectItem value="NOTA_DEBITO">Nota de Débito</SelectItem>
                  <SelectItem value="REMITO">Remito Cta Cte</SelectItem>
                  <SelectItem value="REMITO_OBRA">Remito de Obra (Cta Cte)</SelectItem>
                  <SelectItem value="FAC_INTERNA_CTA_CTE">Factura interna</SelectItem>
                </SelectContent>
              </Select>
              {comboInvalido && (
                <p className="text-[11px] text-destructive mt-1">
                  La Factura A es sólo para Responsables Inscriptos. Este cliente es {clienteSel?.tipo?.replace(/_/g, " ").toLowerCase()}.
                  Elegí Factura B (u otro comprobante).
                </p>
              )}
            </div>
            <div>
              <Label>Condición *</Label>
              <Select
                value={esFacInterna ? "CONTADO" : esCtaCte ? "CTA_CTE" : condVenta}
                onValueChange={(v) => setCondVenta(v as any)}
                disabled={esCtaCte || esFacInterna}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE">Cuenta Corriente</SelectItem>
                </SelectContent>
              </Select>
              {esCtaCte && <p className="text-[11px] text-warning mt-1">No impacta caja. Se cobra después desde Cta Cte.</p>}
              {esFacInterna && <p className="text-[11px] text-muted-foreground mt-1">La factura interna es siempre de contado.</p>}
            </div>
            <div>
              <Label>Cliente *</Label>
              <Popover open={showCli} onOpenChange={setShowCli}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start truncate">
                    {clienteSel ? clienteSel.razon_social : "Buscar cliente…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[92vw] sm:w-[400px] p-2">
                  <Input placeholder="Nombre o CUIT…" value={clienteQuery} onChange={(e) => setClienteQuery(e.target.value)} autoFocus />
                  <div className="max-h-64 overflow-auto mt-2">
                    {clientes.map((c: any) => (
                      <button key={c.id} className="w-full text-left p-2 hover:bg-accent rounded text-sm" onClick={() => { setClienteId(c.id); setShowCli(false); }}>
                        <div className="font-medium flex items-center gap-2">
                          {c.razon_social}
                          {c.condicion_cta_cte && <Badge variant="outline" className="text-[10px]">Cta Cte</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground">{c.cuit_dni ?? "—"}</div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {esRemitoObra && (
              <div className="col-span-2">
                <Label>Obra *</Label>
                <Input placeholder="Nombre / dirección de la obra" value={nombreObra} onChange={(e) => setNombreObra(e.target.value)} />
              </div>
            )}
            {esNota && (
              <div className="col-span-2">
                <Label>Factura que rectifica *</Label>
                <Select value={cbteAsocId} onValueChange={seleccionarFacturaRectifica} disabled={!clienteId}>
                  <SelectTrigger>
                    <SelectValue placeholder={clienteId ? "Elegí la factura…" : "Elegí primero el cliente"} />
                  </SelectTrigger>
                  <SelectContent>
                    {facturasDelCliente.map((f: any) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.numero_comprobante} · {fmtMoney(f.total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {clienteId && facturasDelCliente.length === 0 && (
                  <p className="text-[11px] text-warning mt-1">
                    Este cliente no tiene facturas activas. Una nota siempre rectifica una factura.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground mt-1">
                  AFIP exige que toda nota indique el comprobante que corrige.
                </p>
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Totales">
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span>Subtotal:</span><span className="font-mono">{fmtMoney(totales.sub)}</span></div>
            <div className="flex justify-between"><span>IVA:</span><span className="font-mono">{fmtMoney(totales.iva)}</span></div>
            <div className="flex justify-between items-center gap-2">
              <Label className="text-sm m-0">Percepciones:</Label>
              <NumberInput value={percepciones} onValueChange={setPercepciones} className="h-7 w-28 text-right" />
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-border pt-2 mt-2">
              <span>TOTAL:</span>
              <span className={`font-mono ${esNotaCredito ? "text-destructive" : ""}`}>{fmtMoney(totales.total)}</span>
            </div>
            {esNotaCredito && (
              <p className="text-[11px] text-muted-foreground">
                Es una devolución: baja la deuda del cliente y sale plata de la caja.
              </p>
            )}
            {!esCtaCte && (
              <>
                <div className="flex justify-between text-success"><span>Pagado:</span><span className="font-mono">{fmtMoney(totales.pagado)}</span></div>
                <div className={`flex justify-between font-semibold ${totales.saldo > 0.01 ? "text-destructive" : totales.saldo < -0.01 ? "text-warning" : "text-muted-foreground"}`}>
                  <span>{totales.saldo < 0 ? "Vuelto:" : "Pendiente:"}</span>
                  <span className="font-mono">{fmtMoney(Math.abs(totales.saldo))}</span>
                </div>
              </>
            )}
            {esCtaCte && (
              <div className="flex justify-between text-warning font-semibold border-t border-border pt-2">
                <span>Va a Cta Cte:</span><span className="font-mono">{fmtMoney(totales.total)}</span>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {esNotaDebito && (
        <SectionCard className="space-y-3">
          <h3 className="font-semibold text-sm">Recargo de la nota de débito</h3>
          {!cbteAsocId ? (
            <p className="text-sm text-muted-foreground">Elegí primero la factura que rectifica (arriba).</p>
          ) : (
            <>
              <p className="text-[12px] text-muted-foreground">
                Cargo extra (interés/mora) sobre {facturaSel?.numero_comprobante} ({fmtMoney(facturaSel?.total)}). Se factura con IVA 21%.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>% sobre el total de la factura</Label>
                  <NumberInput value={recargoPct} onValueChange={setRecargoPct} className="mt-1" />
                </div>
                <div>
                  <Label>Monto fijo extra ($, con IVA)</Label>
                  <NumberInput value={recargoMonto} onValueChange={setRecargoMonto} className="mt-1" />
                </div>
              </div>
              <div className="text-sm bg-muted/30 p-2 rounded flex justify-between">
                <span className="text-muted-foreground">Recargo a cobrar (con IVA):</span>
                <span className="font-mono font-semibold">{fmtMoney(recargoConIVA)}</span>
              </div>
            </>
          )}
        </SectionCard>
      )}

      {!esNotaDebito && (
      <SectionCard className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm">Productos</h3>
          <Popover open={showProd} onOpenChange={setShowProd}>
            <PopoverTrigger asChild><Button size="sm" disabled={!effSucursal}><Plus className="h-4 w-4 mr-1" /> Agregar</Button></PopoverTrigger>
            <PopoverContent className="w-[92vw] sm:w-[450px] p-2">
              <Input placeholder="Código o nombre…" value={prodQuery} onChange={(e) => setProdQuery(e.target.value)} autoFocus />
              <div className="max-h-72 overflow-auto mt-2">
                {productosBusqueda.map((p: any) => {
                  const stock = (p.stock_sucursal as any[])?.find(s => s.sucursal_id === effSucursal)?.cantidad ?? 0;
                  return (
                    <button key={p.id} className="w-full text-left p-2 hover:bg-accent rounded text-sm" onClick={() => addProducto(p)}>
                      <div className="flex justify-between"><span className="font-medium">{p.codigo} — {p.nombre}</span><span className="text-xs">Stock: {stock}</span></div>
                      <div className="text-xs text-muted-foreground">{fmtMoney(p.precio_sin_iva)} s/IVA · IVA {p.iva_porcentaje}%</div>
                    </button>
                  );
                })}
                {productosBusqueda.length === 0 && (
                  <p className="text-xs text-muted-foreground p-2">
                    {productosCatalogo.length === 0 ? "No hay productos activos." : "Ningún producto coincide con la búsqueda."}
                  </p>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        {items.length === 0 ? <p className="text-sm text-muted-foreground py-8 text-center">Agregá productos.</p> :
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Código</TableHead><TableHead>Descripción</TableHead>
                <TableHead>Cant.</TableHead><TableHead>P. unit s/IVA</TableHead>
                <TableHead>Desc. %</TableHead><TableHead>IVA</TableHead>
                <TableHead className="text-right">Subtotal</TableHead><TableHead></TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {items.map((it, i) => {
                  const precioEfectivo = it.precio_unitario_sin_iva ?? it.precio_lista ?? 0;
                  const sub = precioEfectivo * (1 - (it.descuento_porcentaje || 0) / 100) * (it.cantidad || 0) * (1 + (it.iva_porcentaje || 0) / 100);
                  const stockWarn = it.stock_disponible !== undefined && it.cantidad > it.stock_disponible;
                  const pisado = it.precio_unitario_sin_iva !== null && Math.abs(Number(it.precio_unitario_sin_iva) - Number(it.precio_lista || 0)) > 0.005;
                  return (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs">{it.codigo}</TableCell>
                      <TableCell className="max-w-xs">
                        <div className="text-sm">{it.descripcion}</div>
                        {stockWarn && <Badge variant="outline" className="mt-1 text-[10px] border-warning text-warning"><AlertTriangle className="h-2.5 w-2.5 mr-1" />Excede stock ({it.stock_disponible})</Badge>}
                      </TableCell>
                      <TableCell><NumberInput className="h-8 w-20" value={it.cantidad} onValueChange={(v) => updateItem(i, "cantidad", v ?? 0)} /></TableCell>
                      <TableCell>
                        <NumberInput className="h-8 w-28" value={it.precio_unitario_sin_iva} onValueChange={(v) => updateItem(i, "precio_unitario_sin_iva", v)} />
                        {pisado && (
                          <div className="text-[10px] text-warning mt-0.5" title="El precio fue modificado a mano">
                            lista: {fmtMoney(it.precio_lista)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell><NumberInput className="h-8 w-20" value={it.descuento_porcentaje} onValueChange={(v) => updateItem(i, "descuento_porcentaje", v ?? 0)} /></TableCell>
                      <TableCell className="text-xs">{it.iva_porcentaje}%</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(sub)}</TableCell>
                      <TableCell><Button size="sm" variant="ghost" onClick={() => removeItem(i)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        }
      </SectionCard>
      )}

      {!esCtaCte && (
        <SectionCard className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm">Formas de pago</h3>
            <Button size="sm" variant="outline" onClick={addPago}><Plus className="h-4 w-4 mr-1" /> Agregar pago</Button>
          </div>
          {pagos.length === 0 ? <p className="text-sm text-muted-foreground py-4 text-center">Sin pagos. La venta puede ser $0 o quedar pendiente.</p> :
            <div className="space-y-2">
              {pagos.map(p => (
                <div key={p.id} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end p-2 border border-border rounded">
                  <div className="col-span-3">
                    <Label className="text-xs">Forma</Label>
                    <Select value={p.forma_pago} onValueChange={(v) => updPago(p.id, "forma_pago", v)}>
                      <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(formaPagoLabel).filter(([k]) => k !== "CTA_CTE").map(([k, l]) => (<SelectItem key={k} value={k}>{l}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2"><Label className="text-xs">Monto</Label>
                    <NumberInput className="h-9" value={p.monto} onValueChange={(v) => updPago(p.id, "monto", v ?? 0)} />
                  </div>
                  <div className="col-span-6 grid grid-cols-2 gap-2">
                    {(p.forma_pago === "TRANSFERENCIA") && (
                      <div className="col-span-2"><Label className="text-xs">Banco / Cuenta</Label><Input className="h-9" value={p.detalle.banco ?? ""} onChange={(e) => updPagoDet(p.id, "banco", e.target.value)} /></div>
                    )}
                    {(p.forma_pago === "TARJETA_DEBITO" || p.forma_pago === "TARJETA_CREDITO") && (
                      <div className="col-span-2"><Label className="text-xs">Tarjeta</Label><Input className="h-9" placeholder="Visa, Naranja…" value={p.detalle.tarjeta ?? ""} onChange={(e) => updPagoDet(p.id, "tarjeta", e.target.value)} /></div>
                    )}
                    {p.forma_pago === "CHEQUE" && (<>
                      <div><Label className="text-xs">Banco</Label><Input className="h-9" value={p.detalle.banco ?? ""} onChange={(e) => updPagoDet(p.id, "banco", e.target.value)} /></div>
                      <div><Label className="text-xs">Nro cheque</Label><Input className="h-9" value={p.detalle.numero ?? ""} onChange={(e) => updPagoDet(p.id, "numero", e.target.value)} /></div>
                      <div><Label className="text-xs">Firmante (Nombre y Apellido)</Label><Input className="h-9" value={p.detalle.firmante ?? ""} onChange={(e) => updPagoDet(p.id, "firmante", e.target.value)} /></div>
                      <div><Label className="text-xs">Fecha cobro</Label><Input type="date" className="h-9" value={p.detalle.fecha_cobro ?? ""} onChange={(e) => updPagoDet(p.id, "fecha_cobro", e.target.value)} /></div>
                    </>)}
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => rmPago(p.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                  </div>
                </div>
              ))}
            </div>
          }
        </SectionCard>
      )}

      <SectionCard>
        <Label>Observaciones</Label>
        <Textarea value={observaciones} onChange={(e) => setObservaciones(e.target.value)} rows={2} className="mt-1" />
      </SectionCard>
    </div>
  );
}
