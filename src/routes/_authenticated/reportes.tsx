import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TableRow, TableCell } from "@/components/ui/table";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { ChartCard } from "@/components/app/chart-card";
import { PeriodFilters } from "@/components/app/period-filters";
import { DataTable } from "@/components/app/data-table";
import { fmtMoney, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { rangeToUtc, todayLocalISO } from "@/lib/dates";
import { FileSpreadsheet, FileText, TrendingUp, Wallet, Receipt, CircleDollarSign, Hash, Undo2 } from "lucide-react";
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
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
    if (!roles?.some((r) => r.role === "admin")) throw redirect({ to: "/" });
  },
  component: ReportesPage,
});

const MEDIO_COLOR: Record<string, string> = {
  EFECTIVO: "var(--color-chart-3)", TRANSFERENCIA: "var(--color-chart-2)",
  TARJETA_CREDITO: "var(--color-chart-1)", TARJETA_DEBITO: "var(--color-chart-4)",
  MERCADO_PAGO: "var(--color-chart-5)", CHEQUE: "var(--color-muted-foreground)",
};
const medioColor = (x: string) => MEDIO_COLOR[x] ?? "var(--color-muted-foreground)";

function firstOfMonthISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function ReportesPage() {
  const [desde, setDesde] = useState(firstOfMonthISO);
  const [hasta, setHasta] = useState(todayLocalISO);
  const [sucId, setSucId] = useState("");

  const { data: sucs = [] } = useQuery({ queryKey: ["sucs"], queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[] });

  const { data: ventas = [], isLoading: loadingVentas } = useQuery({
    queryKey: ["rep-ventas", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      let q = supabase.from("ventas").select(`
        *, cliente:clientes(razon_social), sucursal:sucursales(nombre),
        pagos:venta_pagos(forma_pago, monto)
      `).gte("fecha", gte).lt("fecha", lt).eq("estado", "ACTIVA").order("fecha", { ascending: false });
      if (sucId) q = q.eq("sucursal_id", sucId);
      return (((await q).data) ?? []) as any[];
    },
  });

  const { data: cobranzas = [] } = useQuery({
    queryKey: ["rep-cobranzas", desde, hasta, sucId],
    queryFn: async () => {
      const { gte, lt } = rangeToUtc(desde, hasta);
      let q = supabase.from("cobranzas_cta_cte").select("monto, forma_pago, sucursal_id, fecha").gte("fecha", gte).lt("fecha", lt);
      if (sucId) q = q.eq("sucursal_id", sucId);
      return (((await q).data) ?? []) as any[];
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
  // notas de crédito son devoluciones y se contabilizan aparte, no restan del
  // facturado ni invierten el gráfico diario.
  const ventasSales = useMemo(() => ventas.filter((v) => v.tipo_comprobante !== "NOTA_CREDITO"), [ventas]);
  const notasCredito = useMemo(
    () => ventas.filter((v) => v.tipo_comprobante === "NOTA_CREDITO").reduce((a, v) => a + Math.abs(Number(v.total)), 0),
    [ventas],
  );

  const resumen = useMemo(() => {
    const facturado = ventasSales.reduce((a, v) => a + Number(v.total), 0);
    const cobradoVentas = ventas.reduce((a, v) => a + Number(v.total_pagado), 0);
    const cobradoCtaCte = cobranzas.reduce((a, c) => a + Number(c.monto), 0);
    const cobrado = cobradoVentas + cobradoCtaCte;
    const porPago: Record<string, number> = {};
    ventas.forEach((v) => v.pagos?.forEach((p: any) => { porPago[p.forma_pago] = (porPago[p.forma_pago] ?? 0) + Number(p.monto); }));
    cobranzas.forEach((c) => { porPago[c.forma_pago] = (porPago[c.forma_pago] ?? 0) + Number(c.monto); });
    const ticket = ventasSales.length ? facturado / ventasSales.length : 0;
    const pendienteCtaCte = ctaCte.reduce((a: number, c: any) => a + Math.max(0, Number(c.saldo)), 0);
    return { facturado, cobrado, ticket, cantidad: ventasSales.length, pendienteCtaCte, porPago };
  }, [ventas, ventasSales, cobranzas, ctaCte]);

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
    () => Object.entries(resumen.porPago).map(([formaPago, total]) => ({ formaPago, total: Number(total) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total),
    [resumen.porPago],
  );

  const exportarVentas = (formato: "xlsx" | "pdf") => {
    const rows = ventas.map((v) => ({
      Comprobante: v.numero_comprobante, Fecha: fmtDateTime(v.fecha), Sucursal: v.sucursal?.nombre,
      Cliente: v.cliente?.razon_social, Subtotal: v.subtotal_sin_iva, IVA: v.iva_total, Total: v.total,
    }));
    if (formato === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ventas");
      XLSX.writeFile(wb, `ventas-${desde}-${hasta}.xlsx`);
    } else {
      const doc = new jsPDF();
      doc.setFontSize(14); doc.text(`CasaForma — Ventas ${desde} → ${hasta}`, 14, 16);
      autoTable(doc, {
        startY: 22,
        head: [["Comprob.", "Fecha", "Sucursal", "Cliente", "Subtotal", "IVA", "Total"]],
        body: ventas.map((v) => [
          v.numero_comprobante, fmtDateTime(v.fecha), v.sucursal?.nombre, v.cliente?.razon_social,
          fmtMoney(v.subtotal_sin_iva), fmtMoney(v.iva_total), fmtMoney(v.total),
        ]),
        styles: { fontSize: 7 },
      });
      doc.save(`ventas-${desde}-${hasta}.pdf`);
    }
  };

  const ctaConSaldo = ctaCte.filter((c: any) => Math.abs(Number(c.saldo)) > 0.01);

  return (
    <div>
      <PageHeader title="Reportes" subtitle="Ventas, cobros y cuentas corrientes por período" />

      <PeriodFilters
        from={desde} to={hasta} onFrom={setDesde} onTo={setHasta}
        sucursalId={sucId} onSucursal={setSucId} sucursales={sucs}
      />

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
        <StatCard label="Facturado" value={fmtMoney(resumen.facturado)} icon={TrendingUp} tone="primary" hint="ventas (sin NC)" />
        <StatCard label="Cobrado" value={fmtMoney(resumen.cobrado)} icon={Wallet} tone="success" hint="ventas + cta cte" />
        <StatCard label="Pendiente cta cte" value={fmtMoney(resumen.pendienteCtaCte)} icon={CircleDollarSign} tone="warning" />
        <StatCard label="Devoluciones (NC)" value={fmtMoney(notasCredito)} icon={Undo2} tone="destructive" />
        <StatCard label="Ticket promedio" value={fmtMoney(resumen.ticket)} icon={Receipt} tone="info" />
        <StatCard label="Comprobantes" value={String(resumen.cantidad)} icon={Hash} tone="muted" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <div className="xl:col-span-2">
          <ChartCard title="Ventas por día" subtitle="Total facturado diario" height={260} config={{}}>
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
            <Button variant="outline" size="sm" onClick={() => exportarVentas("xlsx")}><FileSpreadsheet className="h-4 w-4 mr-1" /> Excel</Button>
            <Button variant="outline" size="sm" onClick={() => exportarVentas("pdf")}><FileText className="h-4 w-4 mr-1" /> PDF</Button>
          </div>
          <DataTable columns={["Comprob.", "Fecha", "Sucursal", "Cliente", "Total"]} loading={loadingVentas}
            isEmpty={ventas.length === 0} empty={{ text: "Sin ventas en el período." }}>
            {ventas.map((v) => (
              <TableRow key={v.id}>
                <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>
                <TableCell>{v.cliente?.razon_social}</TableCell>
                <TableCell className={`text-right font-mono ${Number(v.total) < 0 ? "text-destructive" : ""}`}>{fmtMoney(v.total)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </TabsContent>

        <TabsContent value="ctacte">
          <DataTable columns={["Cliente", "CUIT/DNI", "Debe", "Pagado", "Saldo"]}
            isEmpty={ctaConSaldo.length === 0} empty={{ text: "Ningún cliente con saldo pendiente." }}>
            {ctaConSaldo.map((c: any) => {
              const saldo = Number(c.saldo);
              return (
                <TableRow key={c.cliente_id}>
                  <TableCell>{c.razon_social}</TableCell>
                  <TableCell className="font-mono text-xs">{c.cuit_dni ?? "—"}</TableCell>
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
