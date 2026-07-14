import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { ChartCard } from "@/components/app/chart-card";
import { PeriodFilters } from "@/components/app/period-filters";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { todayLocalISO, daysAgoLocalISO, rangeToUtc } from "@/lib/dates";
import {
  normalizarCobros, resumenPagos, totalesPorMedio, serieDiaria,
  type Cobro, type VentaRow, type CobranzaRow,
} from "@/lib/pagos";
import { computeKpiTrend } from "@/components/app/trend";
import { Wallet, Coins, CreditCard, Receipt, Download } from "lucide-react";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
} from "recharts";
import * as XLSX from "xlsx";

export const Route = createFileRoute("/_authenticated/pagos")({
  ssr: false,
  component: PagosPage,
});

const MEDIO_COLOR: Record<string, string> = {
  EFECTIVO: "var(--color-chart-3)",
  TRANSFERENCIA: "var(--color-chart-2)",
  TARJETA_CREDITO: "var(--color-chart-1)",
  TARJETA_DEBITO: "var(--color-chart-4)",
  MERCADO_PAGO: "var(--color-chart-5)",
  CHEQUE: "var(--color-muted-foreground)",
};
const medioLabel = (x: string) => formaPagoLabel[x] ?? x;
const medioColor = (x: string) => MEDIO_COLOR[x] ?? "var(--color-muted-foreground)";
const PAGE_SIZE = 12;

// Corre un rango [from,to] hacia atrás la misma cantidad de días (para tendencia).
function prevRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T03:00:00.000Z`);
  const end = new Date(`${to}T03:00:00.000Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (days - 1));
  return { from: prevStart.toISOString().slice(0, 10), to: prevEnd.toISOString().slice(0, 10) };
}

async function fetchCobros(
  from: string,
  to: string,
  sucursalId: string | null,
): Promise<Cobro[]> {
  const { gte, lt } = rangeToUtc(from, to);

  let ventasQ = supabase
    .from("ventas")
    .select("fecha, numero_comprobante, sucursal_id, cliente:clientes(razon_social), pagos:venta_pagos(forma_pago, monto)")
    .eq("estado", "ACTIVA")
    .gte("fecha", gte)
    .lt("fecha", lt);
  if (sucursalId) ventasQ = ventasQ.eq("sucursal_id", sucursalId);

  let cobrQ = supabase
    .from("cobranzas_cta_cte")
    .select("fecha, sucursal_id, forma_pago, monto, cliente:clientes(razon_social)")
    .gte("fecha", gte)
    .lt("fecha", lt);
  if (sucursalId) cobrQ = cobrQ.eq("sucursal_id", sucursalId);

  const [{ data: ventas }, { data: cobranzas }] = await Promise.all([ventasQ, cobrQ]);
  return normalizarCobros((ventas ?? []) as unknown as VentaRow[], (cobranzas ?? []) as unknown as CobranzaRow[]);
}

function PagosPage() {
  const { data: cu } = useCurrentUser();
  const [from, setFrom] = useState(() => daysAgoLocalISO(30));
  const [to, setTo] = useState(() => todayLocalISO());
  const [sucId, setSucId] = useState("");
  const [medio, setMedio] = useState("");
  const [origen, setOrigen] = useState("");
  const [page, setPage] = useState(1);

  const noSucursal = !!cu && !cu.isAdmin && !cu.sucursal;
  // sucursal efectiva para las queries: admin usa el filtro; no-admin, su propia sucursal.
  const sucursalId = cu?.isAdmin ? (sucId || null) : (cu?.sucursal?.id ?? null);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs-pagos"],
    enabled: !!cu?.isAdmin,
    queryFn: async () => ((await supabase.from("sucursales").select("id, nombre")).data ?? []) as Array<{ id: string; nombre: string }>,
  });

  const { data: cobrosRaw = [], isLoading } = useQuery({
    queryKey: ["pagos", from, to, sucursalId, cu?.user.id],
    enabled: !!cu && !noSucursal,
    queryFn: () => fetchCobros(from, to, sucursalId),
  });

  const prev = useMemo(() => prevRange(from, to), [from, to]);
  const { data: cobrosPrev = [] } = useQuery({
    queryKey: ["pagos-prev", prev.from, prev.to, sucursalId, cu?.user.id],
    enabled: !!cu && !noSucursal,
    queryFn: () => fetchCobros(prev.from, prev.to, sucursalId),
  });

  // Filtros de cliente (medio / origen).
  const cobros = useMemo(
    () => cobrosRaw.filter((c) => (!medio || c.formaPago === medio) && (!origen || c.origen === origen)),
    [cobrosRaw, medio, origen],
  );

  const resumen = useMemo(() => resumenPagos(cobros), [cobros]);
  const resumenPrev = useMemo(() => resumenPagos(cobrosPrev), [cobrosPrev]);
  const serie = useMemo(() => serieDiaria(cobros), [cobros]);
  const donut = useMemo(() => totalesPorMedio(cobros.filter((c) => c.monto > 0)), [cobros]);
  const sparkSerie = useMemo(() => serie.map((d) => d.total), [serie]);

  const pageCount = Math.max(1, Math.ceil(cobros.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const rows = cobros.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const sucNombre = (id: string) =>
    cu?.isAdmin ? (sucs.find((s) => s.id === id)?.nombre ?? "—") : (cu?.sucursal?.nombre ?? "—");

  const exportar = () => {
    const data = cobros.map((c) => ({
      Fecha: fmtDateTime(c.fecha),
      Origen: c.origen === "VENTA" ? "Venta" : "Cta Cte",
      Comprobante: c.comprobante ?? "",
      Cliente: c.cliente ?? "",
      Sucursal: sucNombre(c.sucursalId),
      Medio: medioLabel(c.formaPago),
      Monto: c.monto,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Pagos");
    XLSX.writeFile(wb, `pagos-${from}-${to}.xlsx`);
  };

  const trend = (cur: number, pr: number) => {
    const t = computeKpiTrend(cur, pr);
    return t ? { ...t, hint: "vs período anterior" } : undefined;
  };

  if (noSucursal) {
    return (
      <div>
        <PageHeader title="Pagos" subtitle="Historial de cobros" />
        <div className="rounded-2xl border border-border p-10 text-center shadow-card">
          <Wallet className="h-8 w-8 mx-auto text-muted-foreground/50" />
          <p className="mt-3 font-medium">Tu usuario no tiene sucursal asignada</p>
          <p className="text-sm text-muted-foreground mt-1">Pedile a un administrador que te asigne una para ver los cobros.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Pagos"
        badge={<StatusPill tone="success">HISTÓRICO</StatusPill>}
        subtitle={`${resumen.cantidad} cobros · ${from} → ${to}`}
        actions={
          <Button variant="outline" onClick={exportar} disabled={cobros.length === 0}>
            <Download className="h-4 w-4 mr-1" /> Exportar
          </Button>
        }
      />

      <PeriodFilters
        from={from}
        to={to}
        onFrom={(v) => { setFrom(v); setPage(1); }}
        onTo={(v) => { setTo(v); setPage(1); }}
        sucursalId={cu?.isAdmin ? sucId : undefined}
        onSucursal={cu?.isAdmin ? (v) => { setSucId(v); setPage(1); } : undefined}
        sucursales={cu?.isAdmin ? sucs : undefined}
      >
        <div className="space-y-1">
          <Label className="text-xs">Medio</Label>
          <Select value={medio || "__all__"} onValueChange={(v) => { setMedio(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos</SelectItem>
              {Object.keys(formaPagoLabel).filter((k) => k !== "CTA_CTE").map((k) => (
                <SelectItem key={k} value={k}>{formaPagoLabel[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Origen</Label>
          <Select value={origen || "__all__"} onValueChange={(v) => { setOrigen(v === "__all__" ? "" : v); setPage(1); }}>
            <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todos</SelectItem>
              <SelectItem value="VENTA">Ventas</SelectItem>
              <SelectItem value="CTA_CTE">Cuenta corriente</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PeriodFilters>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <StatCard label="Total neto cobrado" value={fmtMoney(resumen.totalNeto)} icon={Wallet} tone="success"
          spark={sparkSerie} trend={trend(resumen.totalNeto, resumenPrev.totalNeto)} hint="neto de devoluciones" />
        <StatCard label="Efectivo" value={fmtMoney(resumen.efectivo)} icon={Coins} tone="warning"
          trend={trend(resumen.efectivo, resumenPrev.efectivo)} />
        <StatCard label="Electrónico" value={fmtMoney(resumen.electronico)} icon={CreditCard} tone="info"
          trend={trend(resumen.electronico, resumenPrev.electronico)} hint="transf. + tarjetas + MP + cheque" />
        <StatCard label="Ticket promedio" value={fmtMoney(resumen.ticketPromedio)} icon={Receipt} tone="primary"
          trend={trend(resumen.ticketPromedio, resumenPrev.ticketPromedio)} hint="excluye devoluciones" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 mb-4">
        <div className="xl:col-span-2">
          <ChartCard title="Cobrado por medio de pago" subtitle="Distribución (montos positivos)" height={260} config={{}}>
            <PieChart>
              <Pie data={donut} dataKey="total" nameKey="formaPago" innerRadius="60%" outerRadius="88%" paddingAngle={3} strokeWidth={0}>
                {donut.map((d) => <Cell key={d.formaPago} fill={medioColor(d.formaPago)} />)}
              </Pie>
              <RTooltip
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}
                formatter={(v: any, _n: any, p: any) => [fmtMoney(Number(v)), medioLabel(p?.payload?.formaPago ?? "")]}
              />
            </PieChart>
          </ChartCard>
          <div className="mt-2 space-y-1.5 px-1">
            {donut.map((d) => {
              const totalPos = donut.reduce((a, x) => a + x.total, 0) || 1;
              return (
                <div key={d.formaPago} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ background: medioColor(d.formaPago) }} />
                    <span className="text-muted-foreground">{medioLabel(d.formaPago)}</span>
                  </span>
                  <span className="tabular-nums">
                    {fmtMoney(d.total)} <span className="text-xs text-muted-foreground/70">({((d.total / totalPos) * 100).toFixed(1)}%)</span>
                  </span>
                </div>
              );
            })}
            {donut.length === 0 && <p className="text-sm text-muted-foreground">Sin cobros en el período.</p>}
          </div>
        </div>

        <div className="xl:col-span-3">
          <ChartCard title="Cobrado por día" subtitle="Neto diario del período" height={300} config={{}}>
            <BarChart data={serie}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="fecha" stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="var(--muted-foreground)" fontSize={11} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <RTooltip
                contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 12 }}
                formatter={(v: any) => fmtMoney(Number(v))}
                cursor={{ fill: "color-mix(in oklch, var(--muted) 50%, transparent)" }}
              />
              <Bar dataKey="total" fill="var(--color-primary)" radius={[6, 6, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ChartCard>
        </div>
      </div>

      <DataTable
        columns={["Fecha", "Origen", "Cliente", "Sucursal", "Medio", "Monto"]}
        loading={isLoading}
        isEmpty={rows.length === 0}
        empty={{ text: "Sin cobros para este filtro.", icon: <Wallet className="h-7 w-7" /> }}
      >
        {rows.map((c, i) => (
          <TableRow key={i}>
            <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(c.fecha)}</TableCell>
            <TableCell>
              <StatusPill tone={c.origen === "VENTA" ? "info" : "neutral"}>
                {c.origen === "VENTA" ? "Venta" : "Cta Cte"}
              </StatusPill>
            </TableCell>
            <TableCell className="max-w-[220px] truncate">{c.cliente ?? "—"}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{sucNombre(c.sucursalId)}</TableCell>
            <TableCell>
              <span className="inline-flex items-center gap-1.5 text-sm">
                <span className="w-2 h-2 rounded-full" style={{ background: medioColor(c.formaPago) }} />
                {medioLabel(c.formaPago)}
              </span>
            </TableCell>
            <TableCell className={`text-right font-mono ${c.monto < 0 ? "text-destructive" : ""}`}>
              {fmtMoney(c.monto)}
              {c.tipo === "DEVOLUCION" && <span className="ml-1"><StatusPill tone="danger">Devol.</StatusPill></span>}
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {pageCount > 1 && (
        <div className="flex items-center justify-between mt-3 text-sm">
          <span className="text-muted-foreground">Página {pageSafe} de {pageCount} · {cobros.length} cobros</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={pageSafe === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
            <Button size="sm" variant="outline" disabled={pageSafe === pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>Siguiente</Button>
          </div>
        </div>
      )}
    </div>
  );
}
