import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { traerTodo } from "@/lib/supabase-paginado";
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
import { fmtMoney, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { filtroNombreODocumento, fmtDocumento } from "@/lib/documento";
import { ordenarProductosPorRelevancia, TOPE_BUSQUEDA_PRODUCTOS } from "@/lib/postgrest";
import { Trash2, Plus, ArrowLeft, AlertTriangle, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearVenta } from "@/lib/ventas.functions";
import { calcTotalesComprobante } from "@/lib/ventas-totales";
import { conIva, precioFinalConDescuento, round2, sinIva } from "@/lib/fiscal/iva";

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
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const effSucursal = sucursalId || cu?.sucursal?.id || "";

  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-search", clienteQuery],
    queryFn: async () => {
      let q = supabase
        .from("clientes")
        .select("id,razon_social,cuit_dni,tipo,condicion_cta_cte")
        .eq("activo", true)
        .limit(15);
      const filtro = filtroNombreODocumento(clienteQuery);
      if (filtro) q = q.or(filtro);
      return ((await q).data ?? []) as any[];
    },
  });
  const clienteSel = useMemo(
    () => clientes.find((c: any) => c.id === clienteId),
    [clientes, clienteId],
  );

  // Traemos TODOS los productos activos una sola vez y filtramos en el cliente:
  // así el picker muestra la lista completa apenas se abre y filtra al instante
  // mientras escribís, sin un round-trip por tecla.
  //
  // Ojo con el "todos": PostgREST corta en 1000 filas y no avisa. Con 1157
  // productos activos, los que quedaban después del 1000 NO SE PODÍAN VENDER
  // (no aparecían en el buscador). Por eso el paginado explícito, con un orden
  // total (`nombre` no es único: dos productos pueden llamarse igual).
  const { data: productosCatalogo = [] } = useQuery({
    queryKey: ["prods-catalogo"],
    queryFn: async () => {
      const { filas } = await traerTodo<any>(async (desde, hasta) => {
        const { data, error, count } = await supabase
          .from("productos")
          .select(
            "id,codigo,nombre,precio_sin_iva,iva_porcentaje,stock_sucursal(cantidad,sucursal_id)",
            { count: "exact" },
          )
          .eq("activo", true)
          .eq("archivado", false)
          .order("nombre")
          .order("id")
          .range(desde, hasta);
        return { data, error, count };
      });
      return filas;
    },
  });

  const productosBusqueda = useMemo(() => {
    const q = prodQuery.trim().toLowerCase();
    if (!q) return productosCatalogo;
    const coinciden = productosCatalogo.filter(
      (p: any) => p.codigo?.toLowerCase().includes(q) || p.nombre?.toLowerCase().includes(q),
    );
    // Con 1572 productos, "blanco" matchea 161: por código el que se busca
    // queda sepultado. Primero lo que arranca con lo tipeado.
    return ordenarProductosPorRelevancia(coinciden, prodQuery);
  }, [productosCatalogo, prodQuery]);

  const addProducto = (p: any) => {
    const stock =
      (p.stock_sucursal as any[])?.find((s) => s.sucursal_id === effSucursal)?.cantidad ?? 0;
    setItems((prev) => [
      ...prev,
      {
        producto_id: p.id,
        codigo: p.codigo,
        descripcion: p.nombre,
        cantidad: 1,
        precio_unitario_sin_iva: Number(p.precio_sin_iva),
        precio_lista: Number(p.precio_sin_iva),
        iva_porcentaje: Number(p.iva_porcentaje),
        descuento_porcentaje: 0,
        stock_disponible: Number(stock),
      },
    ]);
    setProdQuery("");
  };

  const updateItem = (i: number, k: keyof ItemRow, v: any) => {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [k]: v } : it)));
  };
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  // R4/R5: al elegir la factura que rectifica una NC/ND, se cargan SUS productos en
  // la grilla (editables y borrables: se devuelve/re-cobra sólo lo que corresponda).
  // El precio se toma histórico de la factura (desde_factura fuerza su envío).
  const seleccionarFacturaRectifica = async (facturaId: string) => {
    // Cada llamada se lleva un número, y sólo la ÚLTIMA puede tocar la grilla.
    // Sin esto: elegís la factura A, te arrepentís y pasás a "sin factura" antes
    // de que responda, y la respuesta tardía te repuebla la grilla con los
    // productos de A — con su precio histórico y sin ninguna asociación. Lo
    // mismo al cambiar de cliente o de tipo de comprobante, que también limpian.
    const pedido = ++pedidoFacturaRef.current;
    setCbteAsocId(facturaId);
    if (!facturaId) {
      // Al soltar la factura hay que soltar SUS productos. Si no, quedan en la
      // grilla con el precio histórico pegado (desde_factura los fuerza) pero
      // sin ninguna factura detrás: lo peor de los dos mundos. Los que el
      // usuario agregó a mano se quedan.
      setItems((prev) =>
        prev.some((it) => it.desde_factura) ? prev.filter((it) => !it.desde_factura) : prev,
      );
      return;
    }
    // La Nota de Débito NO trae productos: usa el recargo (R5). Sólo la NC precarga.
    if (tipoComp !== "NOTA_CREDITO") return;
    const { data, error } = await supabase
      .from("venta_items")
      .select(
        "producto_id,codigo,descripcion,cantidad,precio_unitario_sin_iva,iva_porcentaje,descuento_porcentaje",
      )
      .eq("venta_id", facturaId);
    if (pedido !== pedidoFacturaRef.current) return;
    if (error) {
      toast.error("No se pudieron cargar los productos de la factura");
      return;
    }
    setItems(
      (data ?? []).map((it: any) => ({
        producto_id: it.producto_id,
        codigo: it.codigo,
        descripcion: it.descripcion,
        cantidad: Number(it.cantidad),
        precio_unitario_sin_iva: Number(it.precio_unitario_sin_iva),
        precio_lista: Number(it.precio_unitario_sin_iva),
        iva_porcentaje: Number(it.iva_porcentaje),
        descuento_porcentaje: Number(it.descuento_porcentaje ?? 0),
        desde_factura: true,
      })),
    );
    toast.info("Se cargaron los productos de la factura. Editá o borrá los que no correspondan.");
  };

  // Una nota de crédito RESTA (es una devolución). Lo mostramos con el mismo signo
  // con el que se va a guardar, así el cajero ve lo que realmente va a pasar.
  // El flag GLOBAL. La regla del servidor es
  // `permitir_stock_negativo OR puede_vender_sin_stock(uid)`, y acá se espeja
  // entera: si el espejo fuera más estricto que el servidor, se bloquearían
  // ventas que en realidad se pueden hacer.
  const { data: permiteStockNegativo = false } = useQuery({
    queryKey: ["settings-stock-negativo"],
    queryFn: async () =>
      (await supabase.from("settings").select("permitir_stock_negativo").maybeSingle()).data
        ?.permitir_stock_negativo === true,
  });
  const puedeSinStock = permiteStockNegativo || !!cu?.puedeVenderSinStock;

  const esNotaCredito = tipoComp === "NOTA_CREDITO";
  const esNotaDebito = tipoComp === "NOTA_DEBITO";
  const esNota = tipoComp === "NOTA_CREDITO" || tipoComp === "NOTA_DEBITO";
  const esFiscal = ["FACTURA_A", "FACTURA_B", "FACTURA_C", "NOTA_CREDITO", "NOTA_DEBITO"].includes(
    tipoComp,
  );
  // Coherencia comprobante ↔ condición IVA: Factura A sólo a Responsable Inscripto.
  const comboInvalido =
    tipoComp === "FACTURA_A" && !!clienteSel && clienteSel.tipo !== "RESPONSABLE_INSCRIPTO";
  const signo = esNotaCredito ? -1 : 1;

  // La factura que rectifica la nota. La de DÉBITO la exige (es un recargo
  // calculado sobre su total: sin factura no hay base). La de CRÉDITO puede ir
  // sola: es el caso de la devolución cuya factura se emitió en el sistema
  // viejo. Sin factura queda como documento interno y no se manda a AFIP.
  const [cbteAsocId, setCbteAsocId] = useState<string>("");
  // Radix no acepta un SelectItem con value="", así que la opción "sin factura"
  // viaja con un centinela que se traduce a "" al elegirla.
  const SIN_FACTURA = "__sin_factura__";
  // Ver seleccionarFacturaRectifica: descarta las respuestas que quedaron viejas.
  const pedidoFacturaRef = useRef(0);
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
    return round2(round2((base * (Number(recargoPct) || 0)) / 100) + (Number(recargoMonto) || 0));
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
      ? [
          {
            precio_unitario_sin_iva: recargoNeto,
            precio_lista: recargoNeto,
            cantidad: 1,
            descuento_porcentaje: 0,
            iva_porcentaje: 21,
          },
        ]
      : items;
    const { sub, iva, total } = calcTotalesComprobante(itemsCalc, percepciones, signo);
    const pagado = esCtaCte
      ? 0
      : round2(pagos.reduce((a, p) => a + Number(p.monto || 0), 0)) * signo;
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
    pedidoFacturaRef.current++; // que una carga en vuelo no repueble la grilla
    setCbteAsocId("");
    setNombreObra("");
    // R4/R5: los productos precargados de una factura son de este cliente; al
    // cambiarlo, se quitan (los agregados a mano se conservan).
    setItems((prev) =>
      prev.some((it) => it.desde_factura) ? prev.filter((it) => !it.desde_factura) : prev,
    );
  }, [clienteId]);

  // R4/R5: al dejar de ser nota (se cambió a una factura normal), se limpian los
  // productos precargados y la factura asociada. Si no, quedarían con el precio
  // HISTÓRICO pegado y se emitiría una factura cobrando un precio viejo sin aviso.
  useEffect(() => {
    if (!esNota) {
      pedidoFacturaRef.current++; // ídem: descarta la carga que venga en camino
      setCbteAsocId("");
      setItems((prev) =>
        prev.some((it) => it.desde_factura) ? prev.filter((it) => !it.desde_factura) : prev,
      );
    }
  }, [esNota]);

  // R5: al alternar entre NC y ND con la misma factura ya elegida, hay que
  // re-sincronizar la grilla: sólo la NC precarga los productos (la ND usa el
  // recargo). Sin esto, cambiar de ND a NC dejaba la grilla vacía y "Guardar"
  // deshabilitado sin aviso (el cliente no cambió y esNota sigue true).
  useEffect(() => {
    if (!esNota || !cbteAsocId) return;
    if (tipoComp === "NOTA_CREDITO") seleccionarFacturaRectifica(cbteAsocId);
    else {
      pedidoFacturaRef.current++; // ND: nada de lo que venga en camino aplica
      setItems((prev) => prev.filter((it) => !it.desde_factura)); // grilla limpia
    }
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
    if (tipoComp === "FACTURA_C") {
      setTipoComp("FACTURA_B");
      return;
    }
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

  const addPago = () =>
    setPagos((p) => [
      ...p,
      {
        id: crypto.randomUUID(),
        forma_pago: "EFECTIVO",
        // Por defecto, lo que falta cubrir. En una nota de crédito el saldo es
        // negativo (es una devolución), así que precargamos el importe a devolver:
        // el signo lo pone la base, el cajero siempre tipea un número positivo.
        monto: Math.abs(Math.min(0, totales.saldo)) || Math.max(0, totales.saldo),
        detalle: {},
      },
    ]);
  const updPago = (id: string, k: string, v: any) =>
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const updPagoDet = (id: string, k: string, v: any) =>
    setPagos((p) => p.map((x) => (x.id === id ? { ...x, detalle: { ...x.detalle, [k]: v } } : x)));
  const rmPago = (id: string) => setPagos((p) => p.filter((x) => x.id !== id));

  const m = useMutation({
    mutationFn: async () =>
      crear({
        data: {
          sucursal_id: effSucursal,
          // En un remito de obra va nulo a propósito: la ficha la resuelve
          // `crear_venta` desde el nombre de la obra.
          cliente_id: clienteId || null,
          tipo_comprobante: tipoComp as any,
          condicion_venta: esCtaCte ? "CTA_CTE" : condVenta,
          percepciones: Number(percepciones || 0),
          observaciones,
          nombre_obra: esRemitoObra ? nombreObra : null,
          cbte_asoc_id: esNota ? cbteAsocId || null : null,
          idempotency_key: idempotencyKey,
          // R5: la Nota de Débito manda UNA línea de concepto libre (el recargo). El
          // resto de los comprobantes manda la grilla de productos.
          items: esNotaDebito
            ? [
                {
                  producto_id: null,
                  descripcion: `Recargo/interés s/ ${facturaSel?.numero_comprobante ?? ""}`.trim(),
                  cantidad: 1,
                  precio_unitario_sin_iva: recargoNeto,
                  iva_porcentaje: 21,
                  descuento_porcentaje: 0,
                },
              ]
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
                  ((esNota && it.desde_factura) ||
                    Math.abs(precioTipeado - Number(it.precio_lista || 0)) > 0.005);
                return {
                  producto_id: it.producto_id,
                  cantidad: Number(it.cantidad || 0),
                  descuento_porcentaje: Number(it.descuento_porcentaje || 0),
                  ...(pisado ? { precio_unitario_sin_iva: precioTipeado } : {}),
                };
              }),
          pagos: pagos
            .filter((p) => Number(p.monto || 0) > 0)
            .map((p) => ({
              forma_pago: p.forma_pago as any,
              monto: Number(p.monto),
              detalle: p.detalle,
            })),
        },
      }),
    onSuccess: (r: any) => {
      toast.success(
        `${tipoComprobanteLabel[tipoComp] ?? tipoComp} ${r.numero} registrado${r.cta_cte ? " (Cta Cte)" : ""}`,
      );
      navigate({ to: "/ventas" });
    },
    onError: (e: any) => toast.error(e.message),
  });

  /**
   * Las líneas que piden más de lo que hay.
   *
   * Una NOTA DE CRÉDITO devuelve stock y una de débito no toca la grilla, así
   * que ninguna de las dos puede quedar frenada por esto — es justamente la
   * operación que se usa para corregir.
   */
  const lineasSinStock = useMemo(
    () =>
      esNota
        ? []
        : items.filter(
            (it) =>
              (it.cantidad || 0) > 0 &&
              it.stock_disponible !== undefined &&
              (it.cantidad || 0) > it.stock_disponible,
          ),
    [items, esNota],
  );
  // `crear_venta` ya rechaza esto con "Stock insuficiente", pero lo hacía recién
  // al apretar Guardar: la empleada cargaba cliente, productos y forma de pago
  // de una venta de $201.205 para enterarse al final. Ahora se frena arriba.
  const frenaPorStock = !puedeSinStock && lineasSinStock.length > 0;

  /**
   * Una nota de crédito al contado tiene que devolver algo.
   *
   * Sin ningún pago no le devuelve la plata al cliente (no hay pago que salga de
   * la caja) ni le acredita saldo (eso pasa sólo por cuenta corriente): repone
   * el stock, baja el facturado del reporte y la plata no queda en ningún lado.
   * Es el mismo agujero que ya se cerró para las ventas.
   *
   * `crear_venta` también lo rechaza; acá se frena antes para no hacerlo cargar
   * todo el comprobante para enterarse al apretar Guardar.
   */
  const frenaNotaSinCobro =
    esNotaCredito &&
    !esCtaCte &&
    Math.abs(totales.total) >= 0.01 &&
    Math.abs(totales.pagado) < 0.01;

  const canSave =
    !frenaPorStock &&
    !!effSucursal &&
    // En un remito de obra no se elige cliente: las obras no se cargan como
    // clientes. Alcanza con el nombre de la obra (que se exige más abajo) —
    // `crear_venta` le arma la ficha para que la deuda tenga dueño.
    (esRemitoObra || !!clienteId) &&
    // R5: la ND no usa la grilla; exige factura + un recargo > 0. El resto exige
    // al menos un ítem con cantidad > 0.
    (esNotaDebito
      ? !!cbteAsocId && recargoConIVA > 0.005
      : items.length > 0 && items.some((it) => (it.cantidad || 0) > 0)) &&
    (!esFiscal || Math.abs(totales.total) > 0.005) &&
    // (1) no permitir Factura A a un cliente que no es Responsable Inscripto
    !comboInvalido &&
    (!esRemitoObra || nombreObra.trim().length > 0) &&
    // La factura que rectifica ya la exige la ND unas líneas más arriba. La NC
    // puede ir sin ninguna: queda como documento interno (ver el aviso abajo).
    //
    // Al contado se cobra algo: el parcial se permite (queda PARCIAL y el saldo
    // se ve arriba), pero la mercadería no sale sin cobrar un peso — para eso
    // está la cuenta corriente. La nota de DÉBITO queda afuera: se carga a la
    // cuenta, no se cobra en el momento. Mismo criterio que crear_venta.
    (esCtaCte ||
      esNotaDebito ||
      Math.abs(totales.total) < 0.01 ||
      Math.abs(totales.pagado) >= 0.01);

  return (
    <div className="space-y-4">
      {/* El motivo, arriba de todo y en rojo. Un botón gris sin explicación
          obliga a adivinar, y adivinar mal cuesta una venta cargada al pedo. */}
      {frenaPorStock && (
        <SectionCard>
          <p className="text-sm text-destructive">
            <strong>
              No hay stock de{" "}
              {lineasSinStock.length === 1 ? "un producto" : `${lineasSinStock.length} productos`}{" "}
              en {sucs.find((s: any) => s.id === effSucursal)?.nombre ?? "esta sucursal"}.
            </strong>{" "}
            {lineasSinStock
              .map((it) => `${it.descripcion} (hay ${it.stock_disponible}, pedís ${it.cantidad})`)
              .join(" · ")}
            .
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Sacá esos productos o bajá la cantidad. Si la mercadería está en el local y el sistema
            no la tiene, hay que cargarla primero desde Ingresos de mercadería o el conteo de Stock.
          </p>
        </SectionCard>
      )}
      {frenaNotaSinCobro && (
        <SectionCard>
          <p className="text-sm text-destructive">
            <strong>Falta decir cómo se le devuelve la plata al cliente.</strong> Una nota de
            crédito al contado devuelve plata: cargá abajo con qué (efectivo, transferencia…).
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Si en vez de devolverle la plata le queda como saldo a favor para su próxima compra,
            cambiá la condición a <strong>Cuenta corriente</strong>.
          </p>
        </SectionCard>
      )}
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
              <Label>Tipo comprobante *</Label>
              <Select value={tipoComp} onValueChange={(v) => setTipoComp(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
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
                  La Factura A es sólo para Responsables Inscriptos. Este cliente es{" "}
                  {clienteSel?.tipo?.replace(/_/g, " ").toLowerCase()}. Elegí Factura B (u otro
                  comprobante).
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
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE">Cuenta Corriente</SelectItem>
                </SelectContent>
              </Select>
              {esCtaCte && (
                <p className="text-[11px] text-warning mt-1">
                  No impacta caja. Se cobra después desde Cta Cte.
                </p>
              )}
              {esFacInterna && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  La factura interna es siempre de contado.
                </p>
              )}
            </div>
            <div>
              {/* En un remito de obra el cliente es opcional: la obra hace de
                  cliente. Que el asterisco desaparezca evita que alguien lo
                  busque creyendo que falta algo. */}
              <Label>
                Cliente{" "}
                {esRemitoObra ? (
                  <span className="font-normal text-muted-foreground">(opcional)</span>
                ) : (
                  "*"
                )}
              </Label>
              <Popover open={showCli} onOpenChange={setShowCli}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start truncate">
                    {clienteSel ? clienteSel.razon_social : "Buscar cliente…"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[92vw] sm:w-[400px] p-2">
                  <Input
                    placeholder="Nombre o CUIT…"
                    value={clienteQuery}
                    onChange={(e) => setClienteQuery(e.target.value)}
                    autoFocus
                  />
                  <div className="max-h-64 overflow-auto mt-2">
                    {clientes.map((c: any) => (
                      <button
                        key={c.id}
                        className="w-full text-left p-2 hover:bg-accent rounded text-sm"
                        onClick={() => {
                          setClienteId(c.id);
                          setShowCli(false);
                        }}
                      >
                        <div className="font-medium flex items-center gap-2">
                          {c.razon_social}
                          {c.condicion_cta_cte && (
                            <Badge variant="outline" className="text-[10px]">
                              Cta Cte
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {fmtDocumento(c.cuit_dni)}
                        </div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
            {esRemitoObra && (
              <div className="col-span-2">
                <Label>Obra *</Label>
                <Input
                  placeholder="Nombre / dirección de la obra"
                  value={nombreObra}
                  onChange={(e) => setNombreObra(e.target.value)}
                />
              </div>
            )}
            {esNota && (
              <div className="col-span-2">
                <Label>Factura que rectifica {esNotaDebito && "*"}</Label>
                <Select
                  value={cbteAsocId || (esNotaCredito ? SIN_FACTURA : "")}
                  onValueChange={(v) => seleccionarFacturaRectifica(v === SIN_FACTURA ? "" : v)}
                  disabled={!clienteId}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={clienteId ? "Elegí la factura…" : "Elegí primero el cliente"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {/* La salida para la devolución cuya factura no está en el
                        sistema. Sólo para la NC: la ND necesita una factura
                        sobre la cual calcular el recargo. */}
                    {esNotaCredito && (
                      <SelectItem value={SIN_FACTURA}>Sin factura — documento interno</SelectItem>
                    )}
                    {facturasDelCliente.map((f: any) => (
                      <SelectItem key={f.id} value={f.id}>
                        {f.numero_comprobante} · {fmtMoney(f.total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {clienteId && facturasDelCliente.length === 0 && (
                  <p className="text-[11px] text-warning mt-1">
                    {esNotaCredito
                      ? "Este cliente no tiene facturas cargadas. Podés hacerla igual, sin factura."
                      : "Este cliente no tiene facturas activas, y una nota de débito recarga una factura. Cargá la factura primero."}
                  </p>
                )}
                {/* Antes decía "AFIP exige que toda nota indique el comprobante
                    que corrige". No es exacto: la RG 4540/19 pide el comprobante
                    asociado O el período, y este sistema todavía no manda el
                    período. Lo que importa que el usuario sepa no es la norma
                    sino qué le va a pasar al comprobante que está por guardar. */}
                {esNotaCredito && !cbteAsocId ? (
                  <p className="text-[11px] text-warning mt-1">
                    Sin factura queda como <strong>documento interno</strong>: devuelve el stock y
                    la plata (o el saldo), pero no se manda a AFIP y no lleva CAE. Usalo cuando la
                    factura original no esté en el sistema.
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    La nota hereda la letra de la factura que rectifica y la referencia ante AFIP.
                  </p>
                )}
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Totales">
          <div className="space-y-1 text-sm">
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
              <span className={`font-mono ${esNotaCredito ? "text-destructive" : ""}`}>
                {fmtMoney(totales.total)}
              </span>
            </div>
            {esNotaCredito && (
              <p className="text-[11px] text-muted-foreground">
                Es una devolución: baja la deuda del cliente y sale plata de la caja.
              </p>
            )}
            {!esCtaCte && (
              <>
                <div className="flex justify-between text-success">
                  <span>Pagado:</span>
                  <span className="font-mono">{fmtMoney(totales.pagado)}</span>
                </div>
                <div
                  className={`flex justify-between font-semibold ${totales.saldo > 0.01 ? "text-destructive" : totales.saldo < -0.01 ? "text-warning" : "text-muted-foreground"}`}
                >
                  <span>{totales.saldo < 0 ? "Vuelto:" : "Pendiente:"}</span>
                  <span className="font-mono">{fmtMoney(Math.abs(totales.saldo))}</span>
                </div>
              </>
            )}
            {esCtaCte && (
              <div className="flex justify-between text-warning font-semibold border-t border-border pt-2">
                <span>Va a Cta Cte:</span>
                <span className="font-mono">{fmtMoney(totales.total)}</span>
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {esNotaDebito && (
        <SectionCard className="space-y-3">
          <h3 className="font-semibold text-sm">Recargo de la nota de débito</h3>
          {!cbteAsocId ? (
            <p className="text-sm text-muted-foreground">
              Elegí primero la factura que rectifica (arriba).
            </p>
          ) : (
            <>
              <p className="text-[12px] text-muted-foreground">
                Cargo extra (interés/mora) sobre {facturaSel?.numero_comprobante} (
                {fmtMoney(facturaSel?.total)}).
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>% sobre el total de la factura</Label>
                  <NumberInput value={recargoPct} onValueChange={setRecargoPct} className="mt-1" />
                </div>
                <div>
                  <Label>Monto fijo extra ($, final)</Label>
                  <NumberInput
                    value={recargoMonto}
                    onValueChange={setRecargoMonto}
                    className="mt-1"
                  />
                </div>
              </div>
              <div className="text-sm bg-muted/30 p-2 rounded flex justify-between">
                <span className="text-muted-foreground">Recargo a cobrar:</span>
                <span className="font-mono font-semibold">{fmtMoney(recargoConIVA)}</span>
              </div>
            </>
          )}
        </SectionCard>
      )}

      {!esNotaDebito && (
        <SectionCard className="space-y-3">
          <h3 className="font-semibold text-sm">Productos</h3>

          {/* El buscador va ADENTRO de la tarjeta, no en un popover colgado del
              botón "Agregar". Ese botón está pegado al borde derecho, así que el
              panel se salía de la tarjeta y tapaba media pantalla. Además ahora
              se escribe directo, sin tener que apretar nada primero: es lo que
              se hace todo el día en el mostrador. */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar producto por código o nombre…"
              value={prodQuery}
              onChange={(e) => setProdQuery(e.target.value)}
              disabled={!effSucursal}
              data-testid="venta-buscar-producto"
            />
          </div>
          {!effSucursal && (
            <p className="text-xs text-muted-foreground">
              Elegí la sucursal para ver el stock de cada producto.
            </p>
          )}

          {!!effSucursal && prodQuery.trim().length > 0 && productosBusqueda.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {productosBusqueda.length === 1
                ? "1 producto"
                : `${productosBusqueda.length} productos`}
              {productosBusqueda.length > 10 && " · scrolleá la lista para verlos todos"}
            </p>
          )}
          {!!effSucursal && prodQuery.trim().length > 0 && (
            /* La lista es alta a propósito: acá no hay diálogo que la limite y
               con 161 resultados hay que poder recorrerlos. */
            <div className="max-h-[min(60vh,32rem)] overflow-auto rounded-lg border border-border">
              {productosBusqueda.slice(0, TOPE_BUSQUEDA_PRODUCTOS).map((p: any) => {
                const stock =
                  (p.stock_sucursal as any[])?.find((s) => s.sucursal_id === effSucursal)
                    ?.cantidad ?? 0;
                const yaEsta = items.some((it) => it.producto_id === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="w-full p-2 text-left text-sm hover:bg-muted/50"
                    onClick={() => {
                      addProducto(p);
                      setProdQuery("");
                    }}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="w-28 shrink-0 font-mono text-xs">{p.codigo}</span>
                      <span className="truncate font-medium">{p.nombre}</span>
                      <span
                        className={`ml-auto shrink-0 text-xs ${stock <= 0 ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        Stock: {stock}
                      </span>
                    </div>
                    <div className="pl-30 text-xs text-muted-foreground">
                      {fmtMoney(conIva(p.precio_sin_iva, p.iva_porcentaje))}
                      {yaEsta && " · ya está en el comprobante"}
                    </div>
                  </button>
                );
              })}
              {productosBusqueda.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">
                  {productosCatalogo.length === 0
                    ? "No hay productos activos."
                    : "Ningún producto con ese código o nombre."}
                </p>
              )}
              {productosBusqueda.length > TOPE_BUSQUEDA_PRODUCTOS && (
                <p className="border-t border-border p-2 text-xs text-muted-foreground">
                  Se muestran los primeros {TOPE_BUSQUEDA_PRODUCTOS} de {productosBusqueda.length}.
                  Escribí un poco más para afinar.
                </p>
              )}
            </div>
          )}
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Agregá productos.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Descripción</TableHead>
                    <TableHead>Cant.</TableHead>
                    <TableHead>Precio de lista</TableHead>
                    <TableHead>Desc. %</TableHead>
                    <TableHead>Precio final</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it, i) => {
                    const precioEfectivo = it.precio_unitario_sin_iva ?? it.precio_lista ?? 0;
                    const descuento = Math.min(
                      Math.max(Number(it.descuento_porcentaje || 0), 0),
                      100,
                    );
                    const precioFinal = precioFinalConDescuento(
                      precioEfectivo,
                      descuento,
                      it.iva_porcentaje,
                    );
                    const sub = calcTotalesComprobante([it], 0, signo).total;
                    const stockWarn =
                      it.stock_disponible !== undefined && it.cantidad > it.stock_disponible;
                    const pisado =
                      it.precio_unitario_sin_iva !== null &&
                      Math.abs(Number(it.precio_unitario_sin_iva) - Number(it.precio_lista || 0)) >
                        0.005;
                    return (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{it.codigo}</TableCell>
                        <TableCell className="max-w-xs">
                          <div className="text-sm">{it.descripcion}</div>
                          {stockWarn && (
                            <Badge
                              variant="outline"
                              className="mt-1 text-[10px] border-warning text-warning"
                            >
                              <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                              Excede stock ({it.stock_disponible})
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <NumberInput
                            className="h-8 w-20"
                            value={it.cantidad}
                            onValueChange={(v) => updateItem(i, "cantidad", v ?? 0)}
                          />
                        </TableCell>
                        <TableCell>
                          <NumberInput
                            className="h-8 w-28"
                            value={
                              it.precio_unitario_sin_iva === null
                                ? null
                                : conIva(it.precio_unitario_sin_iva, it.iva_porcentaje)
                            }
                            onValueChange={(v) =>
                              updateItem(
                                i,
                                "precio_unitario_sin_iva",
                                v === null ? null : sinIva(v, it.iva_porcentaje),
                              )
                            }
                          />
                          {pisado && (
                            <div
                              className="text-[10px] text-warning mt-0.5"
                              title="El precio fue modificado a mano"
                            >
                              lista: {fmtMoney(conIva(it.precio_lista, it.iva_porcentaje))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <NumberInput
                            className="h-8 w-20"
                            value={it.descuento_porcentaje}
                            onValueChange={(v) => updateItem(i, "descuento_porcentaje", v ?? 0)}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs font-medium">
                          {fmtMoney(precioFinal)}
                        </TableCell>
                        <TableCell className="text-right font-mono">{fmtMoney(sub)}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => removeItem(i)}>
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      )}

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
              {esCtaCte
                ? "En cuenta corriente no se cobra ahora: queda como deuda del cliente."
                : "Sin pagos. Al contado hay que cobrar algo, aunque sea una parte; si se lo lleva sin pagar nada, poné cuenta corriente."}
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
                        {Object.entries(formaPagoLabel)
                          .filter(([k]) => k !== "CTA_CTE")
                          .map(([k, l]) => (
                            <SelectItem key={k} value={k}>
                              {l}
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
                  <div className="col-span-6 grid grid-cols-2 gap-2">
                    {p.forma_pago === "TRANSFERENCIA" && (
                      <div className="col-span-2">
                        <Label className="text-xs">Banco / Cuenta</Label>
                        <Input
                          className="h-9"
                          value={p.detalle.banco ?? ""}
                          onChange={(e) => updPagoDet(p.id, "banco", e.target.value)}
                        />
                      </div>
                    )}
                    {(p.forma_pago === "TARJETA_DEBITO" || p.forma_pago === "TARJETA_CREDITO") && (
                      <div className="col-span-2">
                        <Label className="text-xs">Tarjeta</Label>
                        <Input
                          className="h-9"
                          placeholder="Visa, Naranja…"
                          value={p.detalle.tarjeta ?? ""}
                          onChange={(e) => updPagoDet(p.id, "tarjeta", e.target.value)}
                        />
                      </div>
                    )}
                    {p.forma_pago === "CHEQUE" && (
                      <>
                        <div>
                          <Label className="text-xs">Banco</Label>
                          <Input
                            className="h-9"
                            value={p.detalle.banco ?? ""}
                            onChange={(e) => updPagoDet(p.id, "banco", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Nro cheque</Label>
                          <Input
                            className="h-9"
                            value={p.detalle.numero ?? ""}
                            onChange={(e) => updPagoDet(p.id, "numero", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Firmante (Nombre y Apellido)</Label>
                          <Input
                            className="h-9"
                            value={p.detalle.firmante ?? ""}
                            onChange={(e) => updPagoDet(p.id, "firmante", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Fecha cobro</Label>
                          <Input
                            type="date"
                            className="h-9"
                            value={p.detalle.fecha_cobro ?? ""}
                            onChange={(e) => updPagoDet(p.id, "fecha_cobro", e.target.value)}
                          />
                        </div>
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
