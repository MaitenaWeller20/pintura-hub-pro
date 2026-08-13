import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { traerTodo } from "@/lib/supabase-paginado";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { SectionCard } from "@/components/app/section-card";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtMoney, fmtDateTime } from "@/lib/format";
import { rangeToUtc, todayLocalISO } from "@/lib/dates";
import { ShoppingCart, Wallet, Clock, AlertTriangle, Plus, Boxes, Receipt } from "lucide-react";
import type { ComponentType } from "react";
import { puedeVer } from "@/lib/secciones";

export const Route = createFileRoute("/_authenticated/")({
  component: Dashboard,
});

function Dashboard() {
  const { data: cu } = useCurrentUser();

  const { data: stats } = useQuery({
    queryKey: ["dashboard", cu?.user.id, cu?.sucursal?.id, cu?.isAdmin],
    enabled: !!cu,
    queryFn: async () => {
      const hoyISO = todayLocalISO();
      const { gte: hoyGte, lt: hoyLt } = rangeToUtc(hoyISO, hoyISO);
      const start30 = new Date();
      start30.setDate(start30.getDate() - 30);
      start30.setHours(0, 0, 0, 0);

      // Excluye NOTA_CREDITO: una venta anulada no debe restar del facturado (su NC
      // autogenerada queda ACTIVA con total negativo). Consistente con Reportes.
      let ventasQ = supabase
        .from("ventas")
        .select("id, sucursal_id, fecha, total, total_pagado, estado")
        .gte("fecha", start30.toISOString())
        .eq("estado", "ACTIVA")
        .neq("tipo_comprobante", "NOTA_CREDITO");
      if (!cu!.isAdmin && cu!.sucursal) ventasQ = ventasQ.eq("sucursal_id", cu!.sucursal.id);
      const ventas = ((await ventasQ).data ?? []) as any[];

      // Cobranzas de cta cte de hoy (para "Cobrado hoy" = fondos que entraron).
      let cobrQ = supabase
        .from("cobranzas_cta_cte")
        .select("monto, sucursal_id, fecha")
        .gte("fecha", hoyGte)
        .lt("fecha", hoyLt);
      if (!cu!.isAdmin && cu!.sucursal) cobrQ = cobrQ.eq("sucursal_id", cu!.sucursal.id);
      const cobranzasHoy = ((await cobrQ).data ?? []) as any[];

      // Stock bajo. El mínimo es POR SUCURSAL (igual que en /stock), así que primero
      // marcamos las filas bajas (cantidad <= mínimo) y recién después deduplicamos por
      // producto, quedándonos con la sucursal más crítica. Así un producto con stock
      // bajo en las dos sucursales aparece una sola vez (no duplicado, y el KPI cuenta
      // productos) pero SIGUE alertando aunque el total entre sucursales supere el mínimo.
      //
      // Se lee de stock_inventario filtrando `cargado`: un producto que
      // NADIE CONTÓ TODAVÍA no es "stock bajo", es "sin contar". Sin este filtro
      // el KPI queda inservible — después de la corrección del envase hay ~1150
      // productos en cero que nadie contó nunca.
      const { filas: stocks } = await traerTodo<any>(async (desde, hasta) => {
        let sel = supabase
          .from("stock_inventario")
          .select("producto_id, nombre, codigo, stock_minimo, cantidad, sucursal_id", {
            count: "exact",
          })
          .eq("cargado", true)
          .order("codigo")
          .order("sucursal_id")
          .range(desde, hasta);
        if (!cu!.isAdmin && cu!.sucursal) sel = sel.eq("sucursal_id", cu!.sucursal.id);
        const { data, error, count } = await sel;
        return { data, error, count };
      });
      const bajasPorFila = stocks.filter(
        (s: any) => Number(s.cantidad) <= Number(s.stock_minimo ?? 0),
      );
      const peorPorProducto = new Map<string, { producto: any; cantidad: number }>();
      for (const s of bajasPorFila) {
        const pid = s.producto_id;
        if (!pid) continue;
        const producto = {
          id: s.producto_id,
          nombre: s.nombre,
          codigo: s.codigo,
          stock_minimo: s.stock_minimo,
        };
        const prev = peorPorProducto.get(pid);
        if (!prev || Number(s.cantidad) < prev.cantidad)
          peorPorProducto.set(pid, { producto, cantidad: Number(s.cantidad) });
      }
      const stockBajo = [...peorPorProducto.values()].sort((a, b) => a.cantidad - b.cantidad);

      // Serie 7 días (para sparkline).
      const dayKey = (d: string) =>
        new Date(d).toLocaleDateString("es-AR", {
          timeZone: "America/Argentina/Buenos_Aires",
          day: "2-digit",
          month: "2-digit",
        });
      const last7Keys: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        last7Keys.push(dayKey(d.toISOString()));
      }
      const porDia: Record<string, number> = {};
      ventas.forEach((v) => {
        const k = dayKey(v.fecha);
        porDia[k] = (porDia[k] ?? 0) + Number(v.total);
      });
      const spark7 = last7Keys.map((k) => porDia[k] ?? 0);

      const hoy = new Date(hoyGte);
      const ventasHoy = ventas.filter((v) => new Date(v.fecha) >= hoy);
      const totalHoy = ventasHoy.reduce((a, v) => a + Number(v.total), 0);
      const cobradoVentasHoy = ventasHoy.reduce((a, v) => a + Number(v.total_pagado), 0);
      const cobradoCtaCteHoy = cobranzasHoy.reduce((a, c) => a + Number(c.monto), 0);
      const cobradoHoy = cobradoVentasHoy + cobradoCtaCteHoy;
      const pendienteHoy = totalHoy - cobradoVentasHoy;

      let ultQ = supabase
        .from("ventas")
        .select("id, numero_comprobante, fecha, total, estado_pago, cliente:clientes(razon_social)")
        .eq("estado", "ACTIVA")
        .order("fecha", { ascending: false })
        .limit(6);
      if (!cu!.isAdmin && cu!.sucursal) ultQ = ultQ.eq("sucursal_id", cu!.sucursal.id);
      const ultimas = ((await ultQ).data ?? []) as any[];

      return { totalHoy, cobradoHoy, pendienteHoy, stockBajo, spark7, ultimas };
    },
  });

  const nombre = cu?.profile.nombre_completo?.split(" ")[0] || cu?.profile.username || "";
  const permisos = { isAdmin: !!cu?.isAdmin, secciones: cu?.secciones ?? null };

  return (
    <div>
      <PageHeader
        title={`Hola, ${nombre}`}
        subtitle={
          cu?.isAdmin ? "Vista global de CasaForma" : `Sucursal ${cu?.sucursal?.nombre ?? ""}`
        }
      />

      {/* Los accesos rápidos respetan los permisos por sección. Si no, un
          usuario sin Ventas veía "Nueva venta" y al hacer clic caía en el panel
          de "no tenés acceso": el guard lo frenaba igual, pero la pantalla le
          ofrecía algo que no podía hacer. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {puedeVer("ventas", permisos) && (
          <QuickAction to="/ventas/nueva" icon={Plus} label="Nueva venta" tone="primary" />
        )}
        {puedeVer("pagos", permisos) && (
          <QuickAction to="/pagos" icon={Wallet} label="Cobros" tone="success" />
        )}
        {puedeVer("stock", permisos) && (
          <QuickAction to="/stock" icon={Boxes} label="Ver stock" tone="info" />
        )}
        {puedeVer("cuentas_corrientes", permisos) && (
          <QuickAction to="/cuentas-corrientes" icon={Receipt} label="Cuentas ctes" tone="warning" />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Ventas hoy"
          value={fmtMoney(stats?.totalHoy ?? 0)}
          icon={ShoppingCart}
          tone="primary"
          spark={stats?.spark7}
        />
        <StatCard
          label="Cobrado hoy"
          value={fmtMoney(stats?.cobradoHoy ?? 0)}
          icon={Wallet}
          tone="success"
          hint="ventas + cta cte"
        />
        <StatCard
          label="Pendiente hoy"
          value={fmtMoney(stats?.pendienteHoy ?? 0)}
          icon={Clock}
          tone="warning"
        />
        <StatCard
          label="Productos stock bajo"
          value={String(stats?.stockBajo.length ?? 0)}
          icon={AlertTriangle}
          tone="destructive"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning" /> Alertas de stock bajo
            </span>
          }
          actions={
            puedeVer("stock", permisos) ? (
              <Button size="sm" variant="ghost" asChild>
                <Link to="/stock">Ver stock</Link>
              </Button>
            ) : null
          }
        >
          {(stats?.stockBajo ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Todo OK en niveles de stock.</p>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-auto">
              {stats!.stockBajo.slice(0, 10).map((s: any, i: number) => (
                <li key={i} className="flex justify-between text-sm">
                  <span className="truncate">
                    {s.producto.codigo} — {s.producto.nombre}
                  </span>
                  <span className="text-destructive font-mono">{Number(s.cantidad)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          title={
            <span className="flex items-center gap-2">
              <ShoppingCart className="h-4 w-4" /> Últimas ventas
            </span>
          }
          actions={
            puedeVer("ventas", permisos) ? (
              <Button size="sm" variant="ghost" asChild>
                <Link to="/ventas">Ver todas</Link>
              </Button>
            ) : null
          }
        >
          {(stats?.ultimas ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No hay ventas todavía.</p>
          ) : (
            <div className="text-sm divide-y divide-border">
              {stats!.ultimas.map((v: any) => (
                <div key={v.id} className="py-2 flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground w-28 shrink-0">
                    {v.numero_comprobante}
                  </span>
                  <span className="flex-1 truncate">{v.cliente?.razon_social ?? "—"}</span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {fmtDateTime(v.fecha)}
                  </span>
                  <span className="font-semibold w-24 text-right tabular-nums">
                    {fmtMoney(v.total)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

function QuickAction({
  to,
  icon: Icon,
  label,
  tone,
}: {
  to: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  tone: "primary" | "success" | "info" | "warning";
}) {
  const color = {
    primary: "var(--color-primary)",
    success: "var(--color-success)",
    info: "var(--color-info)",
    warning: "var(--color-warning)",
  }[tone];
  return (
    <Link to={to}>
      <Card className="p-4 flex items-center gap-3 shadow-card hover:shadow-card-hover hover:border-primary/40 transition-all cursor-pointer">
        <div className="stat-chip shrink-0" style={{ ["--chip" as string]: color }}>
          <Icon className="h-5 w-5" />
        </div>
        <span className="font-medium text-sm">{label}</span>
      </Card>
    </Link>
  );
}
