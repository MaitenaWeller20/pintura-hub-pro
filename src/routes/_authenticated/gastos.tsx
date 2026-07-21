/**
 * Gastos varios / diarios — carga simple de un gasto cotidiano (papel, café, flete):
 * "compré tanto, me salió tanto". La plata sale de la caja (movimiento GASTO); la
 * RPC registrar_gasto abre la caja sola si es la primera operación del día.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { toast } from "sonner";
import { Wallet } from "lucide-react";

export const Route = createFileRoute("/_authenticated/gastos")({
  component: GastosPage,
});

const FORMAS = ["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO", "MERCADO_PAGO", "CHEQUE"] as const;

function GastosPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucId, setSucId] = useState("");
  const effSucId = sucId || cu?.sucursal?.id || "";

  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState<number | null>(null);
  const [forma, setForma] = useState("EFECTIVO");

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("id,nombre").order("nombre")).data ?? []) as any[],
  });

  // Gastos del turno actual (los movimientos GASTO de la sesión de caja abierta).
  const { data: gastos = [] } = useQuery({
    queryKey: ["gastos-dia", effSucId],
    enabled: !!effSucId,
    queryFn: async () => {
      const { data: ses } = await supabase.from("caja_sesiones")
        .select("id").eq("sucursal_id", effSucId).eq("estado", "ABIERTA")
        .order("abierta_en", { ascending: false }).limit(1).maybeSingle();
      if (!ses) return [] as any[];
      const { data } = await supabase.from("caja_movimientos")
        .select("*").eq("caja_sesion_id", ses.id).eq("tipo", "GASTO")
        .order("created_at", { ascending: false });
      return (data ?? []) as any[];
    },
  });

  const registrar = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("registrar_gasto", {
        p_sucursal_id: effSucId,
        p_monto: Number(monto || 0),
        p_forma_pago: forma,
        p_descripcion: descripcion,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Gasto registrado");
      setDescripcion(""); setMonto(null); setForma("EFECTIVO");
      qc.invalidateQueries({ queryKey: ["gastos-dia"] });
      qc.invalidateQueries({ queryKey: ["caja-esperado"] });
      qc.invalidateQueries({ queryKey: ["caja-sesion-activa"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const puedeGuardar = !!effSucId && descripcion.trim().length > 0 && (monto ?? 0) > 0 && !registrar.isPending;
  const totalDia = gastos.reduce((a: number, g: any) => a + Number(g.monto), 0);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Gastos varios"
        subtitle="Cargá un gasto cotidiano (papel, café, flete). Sale de la caja del día."
        actions={cu?.isAdmin && (
          <Select value={sucId} onValueChange={setSucId}>
            <SelectTrigger className="w-52"><SelectValue placeholder="Mi sucursal" /></SelectTrigger>
            <SelectContent>{sucs.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        )}
      />

      <SectionCard title="Nuevo gasto">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_10rem_auto] gap-3 items-end">
          <div>
            <Label>¿Qué compraste? *</Label>
            <Input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="Ej: papel higiénico, café, flete"
              onKeyDown={(e) => { if (e.key === "Enter" && puedeGuardar) registrar.mutate(); }} className="mt-1" />
          </div>
          <div>
            <Label>Monto *</Label>
            <NumberInput value={monto} onValueChange={setMonto} className="mt-1" />
          </div>
          <div>
            <Label>Forma</Label>
            <Select value={forma} onValueChange={setForma}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{FORMAS.map((f) => <SelectItem key={f} value={f}>{formaPagoLabel[f]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <Button onClick={() => registrar.mutate()} disabled={!puedeGuardar}>Registrar</Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Gastos de hoy"
        actions={gastos.length > 0 && (
          <span className="text-sm">Total: <span className="font-bold font-mono tabular-nums text-destructive">−{fmtMoney(totalDia)}</span></span>
        )}
      >
        {gastos.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Todavía no cargaste gastos hoy.</p>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Hora</TableHead><TableHead>Descripción</TableHead>
              <TableHead>Forma</TableHead><TableHead className="text-right">Monto</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {gastos.map((g: any) => (
                <TableRow key={g.id}>
                  <TableCell className="text-xs">{fmtDateTime(g.created_at)}</TableCell>
                  <TableCell><span className="inline-flex items-center gap-1.5"><Wallet className="h-3.5 w-3.5 text-muted-foreground" />{g.descripcion}</span></TableCell>
                  <TableCell className="text-xs">{formaPagoLabel[g.forma_pago]}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-destructive">−{fmtMoney(g.monto)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
