import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Plus, FileText } from "lucide-react";

export const Route = createFileRoute("/_authenticated/presupuestos/")({
  component: Presupuestos,
});

// "Si ese cliente viene, tienen que poder asociar el presupuesto" — y encontrarlo
// "por la fecha o por el número", textual.
// Ver docs/superpowers/specs/2026-07-29-presupuestos-design.md

const TONO: Record<string, "success" | "neutral" | "danger"> = {
  ABIERTO: "success",
  CONVERTIDO: "neutral",
  ANULADO: "danger",
};

function Presupuestos() {
  const { data: cu } = useCurrentUser();
  const [q, setQ] = useState("");
  const [estado, setEstado] = useState("todos");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");

  // Los filtros van al servidor. Antes se bajaban los últimos 300 y se filtraba
  // en memoria: buscar un presupuesto viejo por número no lo encontraba nunca, y
  // la pantalla no daba ninguna señal de que faltaban filas.
  const { data: presupuestos = [], isLoading } = useQuery({
    queryKey: ["presupuestos", q, estado, desde, hasta],
    queryFn: async () => {
      // El nombre del cliente vive en otra tabla; se resuelven primero los ids
      // que matchean para poder buscarlos en la misma consulta.
      let idsCliente: string[] = [];
      if (q) {
        idsCliente = (
          (await supabase.from("clientes").select("id").ilike("razon_social", `%${q}%`).limit(20))
            .data ?? []
        ).map((c: any) => c.id);
      }

      let sel = supabase
        .from("presupuestos")
        .select("*, cliente:clientes(razon_social)")
        .order("fecha", { ascending: false })
        .limit(300);

      if (estado !== "todos") sel = sel.eq("estado", estado);
      if (desde) sel = sel.gte("fecha", desde);
      // `fecha` es timestamptz: sin el corrimiento, "hasta el 29" dejaría afuera
      // todo lo del propio 29.
      if (hasta) sel = sel.lt("fecha", `${hasta}T23:59:59.999`);
      if (q) {
        const partes = [`numero.ilike.%${q}%`, `nombre_cliente.ilike.%${q}%`];
        if (idsCliente.length) partes.push(`cliente_id.in.(${idsCliente.join(",")})`);
        sel = sel.or(partes.join(","));
      }
      return ((await sel).data ?? []) as any[];
    },
  });

  const filtrados = presupuestos;

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Presupuestos"
        subtitle={
          filtrados.length === 300
            ? "300 presupuestos (los más nuevos) — afiná la búsqueda o las fechas"
            : `${filtrados.length} presupuesto${filtrados.length === 1 ? "" : "s"}`
        }
        actions={
          <Button asChild>
            <Link to="/presupuestos/nuevo">
              <Plus className="h-4 w-4 mr-1" /> Nuevo presupuesto
            </Link>
          </Button>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Número o cliente…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
            data-testid="buscar-presupuesto"
          />
          <Select value={estado} onValueChange={setEstado}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos</SelectItem>
              <SelectItem value="ABIERTO">Abiertos</SelectItem>
              <SelectItem value="CONVERTIDO">Convertidos</SelectItem>
              <SelectItem value="ANULADO">Anulados</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="w-40"
              aria-label="Desde"
              data-testid="presup-desde"
            />
            <span className="text-muted-foreground text-sm">a</span>
            <Input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="w-40"
              aria-label="Hasta"
              data-testid="presup-hasta"
            />
          </div>
        </div>
      </SectionCard>

      <DataTable
        columns={["Número", "Fecha", "Cliente", "Válido hasta", "Total", "Estado", ""]}
        loading={isLoading}
        isEmpty={filtrados.length === 0}
        empty={{
          text: "Todavía no hay presupuestos. Hacé uno para mandarle precios a un cliente sin que se descuente el stock.",
        }}
      >
        {filtrados.map((p: any) => {
          const vencido =
            p.estado === "ABIERTO" &&
            p.validez_hasta &&
            new Date(p.validez_hasta) < new Date(new Date().toDateString());
          return (
            <TableRow key={p.id} className={p.estado === "ANULADO" ? "opacity-50" : ""}>
              <TableCell className="font-mono text-xs">{p.numero}</TableCell>
              <TableCell className="text-xs">{fmtDate(p.fecha)}</TableCell>
              <TableCell>{p.cliente?.razon_social ?? p.nombre_cliente ?? "—"}</TableCell>
              <TableCell className="text-xs">
                {p.validez_hasta ? fmtDate(p.validez_hasta) : "sin vencimiento"}
                {vencido && (
                  <span className="ml-1 align-middle">
                    <StatusPill tone="warning">vencido</StatusPill>
                  </span>
                )}
              </TableCell>
              <TableCell className="font-mono">{fmtMoney(p.total)}</TableCell>
              <TableCell>
                <StatusPill tone={TONO[p.estado] ?? "neutral"}>
                  {p.estado === "CONVERTIDO" ? "Convertido en venta" : p.estado.toLowerCase()}
                </StatusPill>
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" asChild title="Ver el presupuesto">
                    <Link to="/presupuestos/$id" params={{ id: p.id }}>
                      <FileText className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>
    </div>
  );
}
