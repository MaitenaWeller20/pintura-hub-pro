import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { traerTodo } from "@/lib/supabase-paginado";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatCard } from "@/components/app/stat-card";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/format";
import { ArrowLeft, TrendingDown, TrendingUp, Package } from "lucide-react";

export const Route = createFileRoute("/_authenticated/productos/$id/seguimiento")({
  component: Seguimiento,
});

// "¿Usted cuándo ingresó un pincel? ¿Cuántas cantidades ingresaron? Y en el
// tiempo, ¿cómo se fue vendiendo? Si la gente se lo llevó como cuenta corriente."
//
// Es la pantalla "Seguimiento de Artículos" del sistema viejo. Sólo lectura: la
// data ya estaba entera en stock_movimientos, faltaba resolver "con quién" y
// mostrarla. Ver docs/superpowers/specs/2026-07-29-seguimiento-producto-design.md

const MOVIMIENTO: Record<string, { txt: string; entrada: boolean }> = {
  VENTA: { txt: "Venta", entrada: false },
  ANULACION_VENTA: { txt: "Anulación de venta", entrada: true },
  DEVOLUCION: { txt: "Devolución", entrada: true },
  COMPRA: { txt: "Compra", entrada: true },
  ANULACION_COMPRA: { txt: "Anulación de compra", entrada: false },
  INGRESO_MERCADERIA: { txt: "Ingreso de mercadería", entrada: true },
  ANULACION_INGRESO_MERCADERIA: { txt: "Anulación de ingreso", entrada: false },
  TRANSFERENCIA_IN: { txt: "Entró por transferencia", entrada: true },
  TRANSFERENCIA_OUT: { txt: "Salió por transferencia", entrada: false },
  AJUSTE: { txt: "Ajuste de inventario", entrada: true },
  INGRESO_INICIAL: { txt: "Carga inicial", entrada: true },
};

const PERIODOS = [
  { v: "12", txt: "Últimos 12 meses" },
  { v: "3", txt: "Últimos 3 meses" },
  { v: "1", txt: "Último mes" },
  { v: "0", txt: "Todo" },
];

function Seguimiento() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: cu } = useCurrentUser();
  const [sucursalId, setSucursalId] = useState("todas");
  const [meses, setMeses] = useState("12");

  const { data: producto } = useQuery({
    queryKey: ["producto", id],
    queryFn: async () =>
      (await supabase.from("productos").select("*").eq("id", id).maybeSingle()).data,
  });

  const { data: sucursales = [] } = useQuery({
    queryKey: ["sucursales"],
    queryFn: async () =>
      ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const desde = useMemo(() => {
    if (meses === "0") return null;
    const d = new Date();
    d.setMonth(d.getMonth() - Number(meses));
    return d.toISOString();
  }, [meses]);

  // Paginado: un producto que rota mucho pasa las 1000 filas de PostgREST, y este
  // repo ya se comió ese truncado en silencio más de una vez. El orden tiene que
  // ser total (created_at no es único) o la paginación saltea o repite.
  const { data: movs, isLoading } = useQuery({
    queryKey: ["seguimiento", id, sucursalId, meses],
    queryFn: async () => {
      const { filas, truncado } = await traerTodo<any>(async (d, h) => {
        let q = supabase
          .from("seguimiento_producto")
          .select("*", { count: "exact" })
          .eq("producto_id", id)
          .order("created_at", { ascending: false })
          .order("id")
          .range(d, h);
        if (sucursalId !== "todas") q = q.eq("sucursal_id", sucursalId);
        if (desde) q = q.gte("created_at", desde);
        const { data, error, count } = await q;
        return { data, error, count };
      });
      return { filas, truncado };
    },
  });

  const filas = movs?.filas ?? [];

  // El stock de HOY se lee de stock_sucursal, que es donde vive de verdad. NO se
  // deduce del último movimiento: varios movimientos pueden compartir el mismo
  // created_at (la misma transacción), y ahí "el último" es arbitrario.
  const { data: stockHoy } = useQuery({
    queryKey: ["stock-hoy", id, sucursalId],
    queryFn: async () => {
      let q = supabase.from("stock_sucursal").select("cantidad").eq("producto_id", id);
      if (sucursalId !== "todas") q = q.eq("sucursal_id", sucursalId);
      const { data } = await q;
      return (data ?? []).reduce((a: number, r: any) => a + Number(r.cantidad), 0);
    },
  });

  const resumen = useMemo(() => {
    let entro = 0,
      salio = 0;
    for (const m of filas) {
      const c = Number(m.cantidad);
      if (c > 0) entro += c;
      else salio += -c;
    }
    return { entro, salio };
  }, [filas]);

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title={producto?.nombre ?? "Seguimiento"}
        subtitle={producto ? `Código ${producto.codigo}` : undefined}
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ to: "/productos" })}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Volver
          </Button>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2">
          <Select value={sucursalId} onValueChange={setSucursalId}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas las sucursales</SelectItem>
              {sucursales.map((s: any) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={meses} onValueChange={setMeses}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODOS.map((p) => (
                <SelectItem key={p.v} value={p.v}>
                  {p.txt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Stock hoy"
          value={stockHoy == null ? "—" : String(stockHoy)}
          icon={Package}
        />
        <StatCard label="Entró" value={`+${resumen.entro}`} icon={TrendingUp} />
        <StatCard label="Salió" value={`−${resumen.salio}`} icon={TrendingDown} />
      </div>

      {movs?.truncado && (
        <SectionCard>
          <p className="text-sm text-destructive">
            El listado quedó incompleto: hay más movimientos de los que se pudieron traer. Achicá el
            período.
          </p>
        </SectionCard>
      )}

      <DataTable
        columns={["Fecha", "Movimiento", "Cant.", "Saldo", "Con quién", "Comprobante"]}
        loading={isLoading}
        isEmpty={filas.length === 0}
        empty={{ text: "Este producto no tiene movimientos en el período elegido." }}
      >
        {filas.map((m: any) => {
          const info = MOVIMIENTO[m.tipo] ?? { txt: m.tipo, entrada: true };
          const c = Number(m.cantidad);
          return (
            <TableRow key={m.id}>
              <TableCell className="text-xs whitespace-nowrap">
                {fmtDateTime(m.created_at)}
              </TableCell>
              <TableCell className="text-sm">
                {info.txt}
                {m.motivo && (
                  <span className="block text-[11px] text-muted-foreground">{m.motivo}</span>
                )}
              </TableCell>
              <TableCell
                className={`text-right font-mono font-semibold ${c > 0 ? "text-success" : "text-destructive"}`}
              >
                {c > 0 ? `+${c}` : c}
              </TableCell>
              {/* La columna nació nullable: hay movimientos históricos sin
                  snapshot. Cuando falta se dice, no se inventa un número. */}
              <TableCell className="text-right font-mono">
                {m.cantidad_nueva == null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  Number(m.cantidad_nueva)
                )}
              </TableCell>
              <TableCell className="text-sm">{m.con_quien ?? "—"}</TableCell>
              <TableCell className="text-xs font-mono">
                {m.comprobante ?? "—"}
                {m.condicion_venta === "CTA_CTE" && (
                  <span className="ml-1 align-middle">
                    <StatusPill tone="warning">cta cte</StatusPill>
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>
    </div>
  );
}
