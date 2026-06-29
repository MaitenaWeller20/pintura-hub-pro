import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import {
  TrendingUp, Wallet, AlertTriangle, ShoppingCart, Package, Plus, Truck,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip, BarChart, Bar, CartesianGrid } from "recharts";

export const Route = createFileRoute("/_authenticated/")({
  component: Dashboard,
});

function Dashboard() {
  const { data: cu } = useCurrentUser();

  const { data: stats } = useQuery({
    queryKey: ["dashboard", cu?.user.id, cu?.sucursal?.id, cu?.isAdmin],
    enabled: !!cu,
    queryFn: async () => {
      const today = new Date(); today.setHours(0,0,0,0);
      const start30 = new Date(); start30.setDate(start30.getDate()-30); start30.setHours(0,0,0,0);

      let ventasQ = supabase.from("ventas").select("id, sucursal_id, fecha, total, total_pagado, estado, estado_pago")
        .gte("fecha", start30.toISOString()).eq("estado", "ACTIVA");
      if (!cu!.isAdmin && cu!.sucursal) ventasQ = ventasQ.eq("sucursal_id", cu!.sucursal.id);
      const ventas = ((await ventasQ).data ?? []) as any[];

      const sucs = ((await supabase.from("sucursales").select("id, nombre, codigo")).data ?? []) as any[];

      // Stock bajo
      let stockQ = supabase.from("stock_sucursal")
        .select("cantidad, sucursal_id, producto:productos!inner(id, nombre, codigo, stock_minimo)");
      if (!cu!.isAdmin && cu!.sucursal) stockQ = stockQ.eq("sucursal_id", cu!.sucursal.id);
      const stocks = ((await stockQ).data ?? []) as any[];
      const stockBajo = stocks.filter(s => Number(s.cantidad) <= Number(s.producto?.stock_minimo ?? 0));

      // Top productos vendidos
      let itemsQ = supabase.from("venta_items").select("descripcion, cantidad, venta:ventas!inner(sucursal_id, fecha, estado)")
        .gte("venta.fecha", start30.toISOString()).eq("venta.estado", "ACTIVA");
      if (!cu!.isAdmin && cu!.sucursal) itemsQ = itemsQ.eq("venta.sucursal_id", cu!.sucursal.id);
      const items = ((await itemsQ).data ?? []) as any[];
      const top: Record<string, number> = {};
      items.forEach((i) => { top[i.descripcion] = (top[i.descripcion] ?? 0) + Number(i.cantidad); });
      const topArr = Object.entries(top).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([n,c])=>({ nombre:n, cantidad:c }));

      // Por día
      const porDia: Record<string, number> = {};
      ventas.forEach((v: any) => {
        const d = new Date(v.fecha).toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit" });
        porDia[d] = (porDia[d] ?? 0) + Number(v.total);
      });
      const chartData = Object.entries(porDia).map(([fecha, total]) => ({ fecha, total }));

      const ventasHoy = ventas.filter((v:any) => new Date(v.fecha) >= today);
      const totalHoy = ventasHoy.reduce((a,v:any)=>a+Number(v.total),0);
      const cobradoHoy = ventasHoy.reduce((a,v:any)=>a+Number(v.total_pagado),0);
      const pendienteHoy = totalHoy - cobradoHoy;

      const porSucursal = sucs.map((s:any) => ({
        nombre: s.nombre,
        total: ventas.filter((v:any) => v.sucursal_id === s.id).reduce((a,v:any)=>a+Number(v.total),0),
      }));

      // Últimas ventas
      let ultQ = supabase.from("ventas").select("id, numero_comprobante, fecha, total, estado_pago, cliente:clientes(razon_social)")
        .eq("estado", "ACTIVA").order("fecha", { ascending: false }).limit(8);
      if (!cu!.isAdmin && cu!.sucursal) ultQ = ultQ.eq("sucursal_id", cu!.sucursal.id);
      const ultimas = ((await ultQ).data ?? []) as any[];

      return { totalHoy, cobradoHoy, pendienteHoy, stockBajo, topArr, chartData, porSucursal, ultimas };
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {cu?.isAdmin ? "Vista global de CasaForma" : `Sucursal ${cu?.sucursal?.nombre ?? ""}`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild><Link to="/ventas/nueva"><Plus className="h-4 w-4 mr-1"/> Nueva venta</Link></Button>
          <Button variant="outline" asChild><Link to="/stock">Ver stock</Link></Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={ShoppingCart} label="Ventas hoy" value={fmtMoney(stats?.totalHoy ?? 0)} sub={`${(stats as any)?.ventasHoyCount ?? ""}`} tone="primary" />
        <Kpi icon={Wallet} label="Cobrado hoy" value={fmtMoney(stats?.cobradoHoy ?? 0)} tone="success" />
        <Kpi icon={TrendingUp} label="Pendiente hoy" value={fmtMoney(stats?.pendienteHoy ?? 0)} tone="warning" />
        <Kpi icon={AlertTriangle} label="Productos stock bajo" value={String(stats?.stockBajo.length ?? 0)} tone="destructive" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-2">
          <h3 className="font-semibold mb-3">Ventas últimos 30 días</h3>
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={stats?.chartData ?? []}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="fecha" stroke="var(--muted-foreground)" fontSize={11} />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                <RTooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }}
                  formatter={(v: any) => fmtMoney(Number(v))} />
                <Line type="monotone" dataKey="total" stroke="var(--primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-3">Por sucursal (30d)</h3>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={stats?.porSucursal ?? []}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis dataKey="nombre" stroke="var(--muted-foreground)" fontSize={10} />
                <YAxis stroke="var(--muted-foreground)" fontSize={11} tickFormatter={(v)=>`$${(v/1000).toFixed(0)}k`} />
                <RTooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--border)" }}
                  formatter={(v: any) => fmtMoney(Number(v))} />
                <Bar dataKey="total" fill="var(--primary)" radius={[6,6,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><Package className="h-4 w-4"/> Top 5 productos (30d)</h3>
          {(stats?.topArr ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin ventas en el período.</p>
          ) : (
            <ul className="space-y-2">
              {stats!.topArr.map((p,i) => (
                <li key={i} className="flex justify-between items-center text-sm border-b border-border pb-2 last:border-0">
                  <span className="truncate">{i+1}. {p.nombre}</span>
                  <span className="font-mono text-muted-foreground">{p.cantidad}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="font-semibold mb-3 flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning"/> Alertas stock bajo</h3>
          {(stats?.stockBajo ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Todo OK en niveles de stock.</p>
          ) : (
            <ul className="space-y-1.5 max-h-60 overflow-auto">
              {stats!.stockBajo.slice(0,10).map((s:any,i)=>(
                <li key={i} className="flex justify-between text-sm">
                  <span className="truncate">{s.producto.codigo} — {s.producto.nombre}</span>
                  <span className="text-destructive font-mono">{Number(s.cantidad)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold flex items-center gap-2"><ShoppingCart className="h-4 w-4"/> Últimas ventas</h3>
          <Button size="sm" variant="ghost" asChild><Link to="/ventas">Ver todas</Link></Button>
        </div>
        {(stats?.ultimas ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay ventas todavía.</p>
        ) : (
          <div className="text-sm divide-y divide-border">
            {stats!.ultimas.map((v:any) => (
              <div key={v.id} className="py-2 flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs text-muted-foreground w-32">{v.numero_comprobante}</span>
                <span className="flex-1 truncate">{v.cliente?.razon_social ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{fmtDateTime(v.fecha)}</span>
                <span className="font-semibold w-28 text-right">{fmtMoney(v.total)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, sub, tone }: { icon: any; label: string; value: string; sub?: string; tone: "primary"|"success"|"warning"|"destructive" }) {
  const toneCls: Record<string, string> = {
    primary: "text-primary", success: "text-success", warning: "text-warning", destructive: "text-destructive",
  };
  return (
    <Card className="p-4 kpi-card">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{label}</div>
        <Icon className={`h-5 w-5 ${toneCls[tone]}`} />
      </div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </Card>
  );
}
