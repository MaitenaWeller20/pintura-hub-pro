import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
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

  const { data: presupuestos = [], isLoading } = useQuery({
    queryKey: ["presupuestos"],
    queryFn: async () =>
      ((
        await supabase
          .from("presupuestos")
          .select("*, cliente:clientes(razon_social)")
          .order("fecha", { ascending: false })
          .limit(300)
      ).data ?? []) as any[],
  });

  const filtrados = useMemo(
    () =>
      presupuestos.filter((p: any) => {
        if (estado !== "todos" && p.estado !== estado) return false;
        if (!q) return true;
        const texto = `${p.numero} ${p.cliente?.razon_social ?? ""} ${p.nombre_cliente ?? ""}`;
        return texto.toLowerCase().includes(q.toLowerCase());
      }),
    [presupuestos, q, estado],
  );

  if (!cu) return null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Presupuestos"
        subtitle={`${filtrados.length} de ${presupuestos.length}`}
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
            placeholder="Buscar por número o cliente…"
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
