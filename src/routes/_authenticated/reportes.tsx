import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TableRow, TableCell } from "@/components/ui/table";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { ChartCard } from "@/components/app/chart-card";
import { PeriodFilters } from "@/components/app/period-filters";
import { DataTable } from "@/components/app/data-table";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { fmtDocumento } from "@/lib/documento";
import { rangeToUtc, todayLocalISO } from "@/lib/dates";
import { COLUMNAS_VENTA_REPORTE } from "@/lib/ventas-proyeccion";
import { clasificarFacturacion, resumirCobros, resumirVentas } from "@/lib/reportes-ventas";
import { traerTodo } from "@/lib/supabase-paginado";
import { FileSpreadsheet, FileText, TrendingUp, Wallet, Receipt, CircleDollarSign, Hash, Undo2, ChevronDown, ChevronRight } from "lucide-react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
} from "recharts";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/reportes")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: esAdmin, error } = await supabase.rpc("is_admin", { _user_id: data.user.id });
    if (error || esAdmin !== true) throw redirect({ to: "/" });
  },
  component: ReportesPage,
});

const MEDIO_COLOR: Record<string, string> = {
  EFECTIVO: "var(--color-chart-3)", TRANSFERENCIA: "var(--color-chart-2)",
  TARJETA_CREDITO: "var(--color-chart-1)", TARJETA_DEBITO: "var(--color-chart-4)",
  QR: "var(--color-primary)",
  CANJE: "var(--color-chart-5)",
  MERCADO_PAGO: "var(--color-chart-5)", CHEQUE: "var(--color-muted-foreground)",
};
const medioColor = (x: string) => MEDIO_COLOR[x] ?? "var(--color-muted-foreground)";

function estadoFacturacionLabel(estado: ReturnType<typeof clasificarFacturacion>) {
  if (estado === "FACTURADO") return "Facturado";
  if (estado === "SIN_CAE") return "Sin CAE real";
  return "Sin facturar";
}

function firstOfMonthISO() {
  return `${todayLocalISO().slice(0, 7)}-01`;
}

function ReportesPage() {
  const [desde, setDesde] = useState(firstOfMonthISO);
  const [hasta, setHasta] = useState(todayLocalISO);
  const [sucId, setSucId] = useState("");
  const [ventaAbierta, setVentaAbierta] = useState<string | null>(null);

  const { data: sucs = [] } = useQuery({ queryKey: ["sucs"], queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[] });

  const { data: ventas = [], isLoading: loadingVentas, error: errorVentas, refetch: refetchVentas } = useQuery({
    queryKey: ["rep-ventas", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      const { filas, truncado } = await traerTodo(async (inicio, fin) => {
        let q = supabase.from("ventas").select(`
          ${COLUMNAS_VENTA_REPORTE},percepciones,estado,cae,afip_estado,afip_simulado,afip_modo,afip_cbte_asoc_id,
          cliente:clientes(razon_social),sucursal:sucursales(nombre)
        `, { count: "exact" }).gte("fecha", gte).lt("fecha", lt)
          .order("fecha", { ascending: false }).order("id", { ascending: false }).range(inicio, fin);
        if (sucId) q = q.eq("sucursal_id", sucId);
        return await q;
      }, { tamanoPagina: 500 });
      if (truncado) throw new Error("El reporte de ventas excede el límite de filas");
      return filas;
    },
  });

  const { data: pagosVentas = [], isLoading: loadingPagos, error: errorPagos } = useQuery({
    queryKey: ["rep-pagos-ventas", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      const { filas, truncado } = await traerTodo(async (inicio, fin) => {
        let q = supabase.from("venta_pagos").select(`
          id, monto, forma_pago, created_at,
          venta:ventas!inner(estado, sucursal_id, tipo_comprobante, afip_cbte_asoc_id, afip_cbte_tipo, cae, afip_estado, afip_simulado, afip_modo, afip_validez)
        `, { count: "exact" }).gte("created_at", gte).lt("created_at", lt)
          .order("created_at", { ascending: false }).order("id", { ascending: false }).range(inicio, fin);
        if (sucId) q = q.eq("venta.sucursal_id", sucId);
        return await q;
      }, { tamanoPagina: 500 });
      if (truncado) throw new Error("El reporte de pagos excede el límite de filas");
      return filas;
    },
  });

  const { data: cobranzas = [], isLoading: loadingCobranzas, error: errorCobranzas } = useQuery({
    queryKey: ["rep-cobranzas", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      const { filas, truncado } = await traerTodo(async (inicio, fin) => {
        let q = supabase.from("cobranzas_cta_cte").select("id, monto, forma_pago, sucursal_id, fecha", { count: "exact" })
          .gte("fecha", gte).lt("fecha", lt).order("fecha", { ascending: false })
          .order("id", { ascending: false }).range(inicio, fin);
        if (sucId) q = q.eq("sucursal_id", sucId);
        return await q;
      }, { tamanoPagina: 500 });
      if (truncado) throw new Error("El reporte de cobranzas excede el límite de filas");
      return filas;
    },
  });

  const { data: ctaCte = [] } = useQuery({
    queryKey: ["rep-ctacte"],
    queryFn: async () => ((await supabase.from("cuenta_corriente_saldos")
      .select("cliente_id, razon_social, cuit_dni, total_debe, total_pagado, saldo")
      .order("saldo", { ascending: false })).data ?? []) as any[],
  });

  const { data: movs = [], isLoading: loadingMovs } = useQuery({
    queryKey: ["rep-movs", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      let q = supabase.from("stock_movimientos").select(`
        *, producto:productos(codigo,nombre), sucursal:sucursales(nombre)
      `).gte("created_at", gte).lt("created_at", lt).order("created_at", { ascending: false }).limit(500);
      if (sucId) q = q.eq("sucursal_id", sucId);
      return (((await q).data) ?? []) as any[];
    },
  });

  // "Ventas" = comprobantes de venta (facturas, remitos, notas de débito). Las
  // notas de crédito son devoluciones y se contabilizan aparte.
  const ventasSales = useMemo(() => ventas.filter((v) => v.estado === "ACTIVA" && v.tipo_comprobante !== "NOTA_CREDITO"), [ventas]);
  const ventasResumen = useMemo(() => resumirVentas(ventas), [ventas]);

  const resumen = useMemo(() => {
    const cobros = resumirCobros(pagosVentas, cobranzas);
    const pendienteCtaCte = ctaCte.reduce((a: number, c: any) => a + Math.max(0, Number(c.saldo)), 0);
    return { ...ventasResumen, cobros, pendienteCtaCte };
  }, [ventasResumen, pagosVentas, cobranzas, ctaCte]);

  const porDia = useMemo(() => {
    const m = new Map<string, number>();
    const order: string[] = [];
    [...ventasSales].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).forEach((v) => {
      const k = new Date(v.fecha).toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit" });
      if (!m.has(k)) order.push(k);
      m.set(k, (m.get(k) ?? 0) + Number(v.total));
    });
    return order.map((fecha) => ({ fecha, total: m.get(fecha)! }));
  }, [ventasSales]);

  const donut = useMemo(
    () => Object.entries(resumen.cobros.porPago).map(([formaPago, total]) => ({ formaPago, total: Number(total) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total),
    [resumen.cobros.porPago],
  );

  const exportarVentas = (formato: "xlsx" | "pdf") => {
    const rows = ventas.map((v) => ({
      Comprobante: v.numero_comprobante, Fecha: fmtDateTime(v.fecha), Sucursal: v.sucursal?.nombre,
      Cliente: v.cliente?.razon_social, Tipo: tipoComprobanteLabel[v.tipo_comprobante] ?? v.tipo_comprobante,
      Estado: v.estado === "ANULADA" ? "Anulada" : "Activa",
      Facturacion: estadoFacturacionLabel(clasificarFacturacion(v)),
      "CAE real": clasificarFacturacion(v) === "FACTURADO" ? v.cae : "",
      Neto: v.subtotal_sin_iva, IVA: v.iva_total, Percepciones: v.percepciones,
      Total: v.total, "Pagado acumulado": v.total_pagado,
    }));
    if (formato === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ventas");
      XLSX.writeFile(wb, `ventas-${desde}-${hasta}.xlsx`);
    } else {
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFontSize(14); doc.text(`Quimex — Ventas ${desde} → ${hasta}`, 14, 16);
      autoTable(doc, {
        startY: 22,
        head: [["Comprob.", "Fecha", "Sucursal", "Cliente", "Tipo", "Estado", "Facturación", "Neto", "IVA", "Percep.", "Total", "Pagado acum."]],
        body: ventas.map((v) => [
          v.numero_comprobante, fmtDateTime(v.fecha), v.sucursal?.nombre, v.cliente?.razon_social,
          tipoComprobanteLabel[v.tipo_comprobante] ?? v.tipo_comprobante,
          v.estado === "ANULADA" ? "Anulada" : "Activa",
          `${estadoFacturacionLabel(clasificarFacturacion(v))}${clasificarFacturacion(v) === "FACTURADO" ? ` · CAE ${v.cae}` : ""}`,
          fmtMoney(v.subtotal_sin_iva), fmtMoney(v.iva_total), fmtMoney(v.percepciones),
          fmtMoney(v.total), fmtMoney(v.total_pagado),
        ]),
        styles: { fontSize: 6 },
      });
      doc.save(`ventas-${desde}-${hasta}.pdf`);
    }
  };

  const ctaConSaldo = ctaCte.filter((c: any) => Math.abs(Number(c.saldo)) > 0.01);
  const cobrosListos = !loadingPagos && !loadingCobranzas && !errorPagos && !errorCobranzas;
  const mostrarCobro = (monto: number) => cobrosListos ? fmtMoney(monto) : "—";

  return (
    <div>
      <PageHeader title="Reportes" subtitle="Ventas, cobros y cuentas corrientes por período" />

      <PeriodFilters
        from={desde} to={hasta} onFrom={setDesde} onTo={setHasta}
        sucursalId={sucId} onSucursal={setSucId} sucursales={sucs}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4 mb-4">
        <StatCard label="Vendido" value={loadingVentas || errorVentas ? "—" : fmtMoney(resumen.vendido)} icon={TrendingUp} tone="primary" hint="ventas activas (sin NC)" />
        <StatCard label="Cobrado" value={mostrarCobro(resumen.cobros.total)} icon={Wallet} tone="success" hint="pagos del período" />
        <StatCard label="IVA con CAE" value={loadingVentas || errorVentas ? "—" : fmtMoney(resumen.ivaConCae)} icon={Receipt} tone="info" hint="comprobantes autorizados por fecha de venta" />
        <StatCard label="Pendiente cta cte" value={fmtMoney(resumen.pendienteCtaCte)} icon={CircleDollarSign} tone="warning" />
        <StatCard label="Devoluciones (NC)" value={loadingVentas || errorVentas ? "—" : fmtMoney(resumen.notasCredito)} icon={Undo2} tone="destructive" />
        <StatCard label="Ticket promedio" value={loadingVentas || errorVentas ? "—" : fmtMoney(resumen.ticket)} icon={Receipt} tone="info" />
        <StatCard label="Comprobantes" value={loadingVentas || errorVentas ? "—" : String(resumen.cantidad)} icon={Hash} tone="muted" hint="ventas activas (sin NC)" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 mb-6">
        <p className="text-sm font-semibold mb-3">Detalle de lo cobrado</p>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          <div><p className="text-muted-foreground">Facturado con CAE</p><p className="font-mono font-semibold">{mostrarCobro(resumen.cobros.facturado)}</p></div>
          <div><p className="text-muted-foreground">Fiscal sin CAE real</p><p className="font-mono font-semibold">{mostrarCobro(resumen.cobros.sinCae)}</p></div>
          <div><p className="text-muted-foreground">Sin facturar</p><p className="font-mono font-semibold">{mostrarCobro(resumen.cobros.sinFacturar)}</p></div>
          <div><p className="text-muted-foreground">Cobranza cta. cte.</p><p className="font-mono font-semibold">{mostrarCobro(resumen.cobros.cuentaCorriente)}</p></div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">Las cobranzas de cuenta corriente se muestran aparte porque no guardan una imputación fiscal por comprobante.</p>
        {(errorPagos || errorCobranzas) && <p className="text-xs text-destructive mt-2">No se pudo cargar todo el detalle de cobros. Revisá la conexión y actualizá el reporte.</p>}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <div className="xl:col-span-2">
          <ChartCard title="Ventas por día" subtitle="Total vendido diario" height={260} config={{}}>
            <BarChart data={porDia}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="fecha" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <RTooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }} formatter={(v: any) => fmtMoney(Number(v))} cursor={{ fill: "color-mix(in oklch, var(--muted) 50%, transparent)" }} />
              <Bar dataKey="total" fill="var(--color-primary)" radius={[6, 6, 0, 0]} maxBarSize={44} />
            </BarChart>
          </ChartCard>
        </div>
        <ChartCard title="Cobrado por medio" subtitle="Distribución del período" height={260} config={{}}>
          <PieChart>
            <Pie data={donut} dataKey="total" nameKey="formaPago" innerRadius="58%" outerRadius="86%" paddingAngle={3} strokeWidth={0}>
              {donut.map((d) => <Cell key={d.formaPago} fill={medioColor(d.formaPago)} />)}
            </Pie>
            <RTooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }} formatter={(v: any, _n: any, p: any) => [fmtMoney(Number(v)), formaPagoLabel[p?.payload?.formaPago] ?? p?.payload?.formaPago]} />
          </PieChart>
        </ChartCard>
      </div>

      <Tabs defaultValue="ventas">
        <TabsList>
          <TabsTrigger value="ventas">Ventas</TabsTrigger>
          <TabsTrigger value="ctacte">Cuentas corrientes</TabsTrigger>
          <TabsTrigger value="stock">Movimientos stock</TabsTrigger>
        </TabsList>

        <TabsContent value="ventas" className="space-y-3">
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={loadingVentas || !!errorVentas} onClick={() => exportarVentas("xlsx")}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
            <Button variant="outline" size="sm" disabled={loadingVentas || !!errorVentas} onClick={() => exportarVentas("pdf")}><FileText className="h-4 w-4 mr-1" /> PDF</Button>
          </div>
          <DataTable columns={["", "Comprob.", "Fecha", "Sucursal", "Cliente", "Tipo", "Estado", "Facturación", "Neto", "IVA", "Percep.", "Total", "Pagado acum."]}
            loading={loadingVentas} error={errorVentas ? "No se pudieron cargar las ventas." : undefined}
            onRetry={() => { void refetchVentas(); }}
            isEmpty={ventas.length === 0} empty={{ text: "Sin ventas en el período." }}>
            {ventas.map((v) => {
              const estado = clasificarFacturacion(v);
              const abierta = ventaAbierta === v.id;
              return (
                <Fragment key={v.id}>
                  <TableRow className={v.estado === "ANULADA" ? "opacity-60" : ""}>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`${abierta ? "Ocultar" : "Ver"} detalle de ${v.numero_comprobante}`}
                        aria-expanded={abierta} onClick={() => setVentaAbierta(abierta ? null : v.id)}>
                        {abierta ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">{v.numero_comprobante}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(v.fecha)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>
                    <TableCell>{v.cliente?.razon_social}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{tipoComprobanteLabel[v.tipo_comprobante] ?? v.tipo_comprobante}</TableCell>
                    <TableCell className="text-xs">{v.estado === "ANULADA" ? "Anulada" : "Activa"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      <span className={estado === "FACTURADO" ? "text-success" : estado === "SIN_CAE" ? "text-warning" : "text-muted-foreground"}>
                        {estadoFacturacionLabel(estado)}
                      </span>
                      {estado === "FACTURADO" && <span className="block font-mono text-[11px] text-muted-foreground">CAE {v.cae}</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{fmtMoney(v.subtotal_sin_iva)}</TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{fmtMoney(v.iva_total)}</TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{fmtMoney(v.percepciones)}</TableCell>
                    <TableCell className={`text-right font-mono whitespace-nowrap ${Number(v.total) < 0 ? "text-destructive" : ""}`}>{fmtMoney(v.total)}</TableCell>
                    <TableCell className="text-right font-mono whitespace-nowrap">{fmtMoney(v.total_pagado)}</TableCell>
                  </TableRow>
                  {abierta && (
                    <TableRow>
                      <TableCell colSpan={13} className="bg-muted/30 p-4">
                        <DetalleVenta ventaId={v.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </DataTable>
          <p className="text-xs text-muted-foreground">Los importes de cada venta corresponden a su fecha de venta. “Pagado acum.” muestra lo cobrado hasta hoy; el resumen “Cobrado” usa la fecha de cada pago.</p>
        </TabsContent>

        <TabsContent value="ctacte">
          <DataTable columns={["Cliente", "CUIT/DNI", "Debe", "Pagado", "Saldo"]}
            isEmpty={ctaConSaldo.length === 0} empty={{ text: "Ningún cliente con saldo pendiente." }}>
            {ctaConSaldo.map((c: any) => {
              const saldo = Number(c.saldo);
              return (
                <TableRow key={c.cliente_id}>
                  <TableCell>{c.razon_social}</TableCell>
                  <TableCell className="font-mono text-xs">{fmtDocumento(c.cuit_dni)}</TableCell>
                  <TableCell className="text-right font-mono">{fmtMoney(c.total_debe)}</TableCell>
                  <TableCell className="text-right font-mono text-success">{fmtMoney(c.total_pagado)}</TableCell>
                  <TableCell className={`text-right font-mono font-semibold ${saldo > 0.01 ? "text-destructive" : "text-success"}`}>
                    {fmtMoney(saldo)}{saldo < -0.01 && " a favor"}
                  </TableCell>
                </TableRow>
              );
            })}
          </DataTable>
        </TabsContent>

        <TabsContent value="stock">
          <DataTable columns={["Fecha", "Tipo", "Producto", "Sucursal", "Cantidad", "Motivo"]} loading={loadingMovs}
            isEmpty={movs.length === 0} empty={{ text: "Sin movimientos de stock en el período." }}>
            {movs.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="text-xs">{fmtDateTime(m.created_at)}</TableCell>
                <TableCell className="text-xs">{m.tipo}</TableCell>
                <TableCell className="text-xs">{m.producto?.codigo} — {m.producto?.nombre}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{m.sucursal?.nombre}</TableCell>
                <TableCell className={`text-right font-mono ${Number(m.cantidad) >= 0 ? "text-success" : "text-destructive"}`}>{Number(m.cantidad)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{m.motivo}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DetalleVenta({ ventaId }: { ventaId: string }) {
  const { data: items = [], isLoading, error } = useQuery({
    queryKey: ["rep-venta-items", ventaId],
    queryFn: async () => {
      const { data, error } = await supabase.from("venta_items")
        .select("id, codigo, descripcion, cantidad, precio_unitario_sin_iva, descuento_porcentaje, subtotal_sin_iva, iva_porcentaje, iva_monto, subtotal_con_iva")
        .eq("venta_id", ventaId).order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando detalle…</p>;
  if (error) return <p className="text-sm text-destructive">No se pudo cargar el detalle de esta venta.</p>;
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Esta venta no tiene renglones registrados.</p>;

  return (
    <div className="overflow-x-auto">
      <p className="text-sm font-medium mb-2">Artículos e IVA</p>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground border-b border-border">
          <tr>
            <th className="text-left py-2 pr-3">Código</th><th className="text-left py-2 pr-3">Descripción</th>
            <th className="text-right py-2 px-3">Cant.</th><th className="text-right py-2 px-3">Precio neto</th>
            <th className="text-right py-2 px-3">Desc.</th><th className="text-right py-2 px-3">Neto</th>
            <th className="text-right py-2 px-3">Alícuota</th><th className="text-right py-2 px-3">IVA</th>
            <th className="text-right py-2 pl-3">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-border/50 last:border-0">
              <td className="py-2 pr-3 font-mono">{item.codigo}</td>
              <td className="py-2 pr-3">{item.descripcion}</td>
              <td className="py-2 px-3 text-right font-mono">{Number(item.cantidad)}</td>
              <td className="py-2 px-3 text-right font-mono">{fmtMoney(item.precio_unitario_sin_iva)}</td>
              <td className="py-2 px-3 text-right font-mono">{Number(item.descuento_porcentaje)}%</td>
              <td className="py-2 px-3 text-right font-mono">{fmtMoney(item.subtotal_sin_iva)}</td>
              <td className="py-2 px-3 text-right font-mono">{Number(item.iva_porcentaje)}%</td>
              <td className="py-2 px-3 text-right font-mono">{fmtMoney(item.iva_monto)}</td>
              <td className="py-2 pl-3 text-right font-mono">{fmtMoney(item.subtotal_con_iva)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
