/**
 * Arqueo de caja — sesión operativa: abrir con fondo, operar (las ventas/cobranzas
 * se atan solas a la sesión), registrar gastos/retiros, y cerrar declarando lo
 * contado por forma de pago para ver la diferencia.
 *
 * Complementa la "Rendición" (histórico/reporte). Toda la lógica de plata vive en
 * las RPC abrir_caja / registrar_movimiento_caja / cerrar_caja (SECURITY DEFINER);
 * esta pantalla sólo las orquesta.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NumberInput } from "@/components/ui/number-input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDate, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { LockOpen, Lock, Plus, Wallet, TrendingUp, TrendingDown, Printer } from "lucide-react";
import { toast } from "sonner";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/arqueo")({
  component: ArqueoPage,
});

// Formas de pago que son plata en la caja (todas menos cuenta corriente).
const FORMAS = ["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO", "MERCADO_PAGO", "CHEQUE"] as const;
type CajaForma = { entra: number; sale: number; neto: number };
const neto = (c?: CajaForma) => Number(c?.neto ?? 0);
const TIPO_MOV_LABEL: Record<string, string> = { INGRESO: "Ingreso", GASTO: "Gasto", RETIRO: "Retiro", INICIAL: "Fondo inicial" };

// PDF del cierre de una sesión: esperado/contado/diferencia por forma + efectivo dejado.
function pdfCierre(s: any, sucNombre: string) {
  const doc = new jsPDF();
  const W = doc.internal.pageSize.getWidth();
  doc.setFontSize(14); doc.text("CASAFORMA", 14, 16);
  doc.setFontSize(11); doc.text("Cierre de caja", W / 2, 16, { align: "center" });
  doc.setFontSize(9);
  doc.text(`Sucursal: ${sucNombre}`, 14, 24);
  doc.text(`Abierta: ${fmtDateTime(s.abierta_en)}`, 14, 29);
  doc.text(`Cerrada: ${fmtDateTime(s.cerrada_en)}`, 14, 34);
  doc.text(`Fondo inicial: ${fmtMoney(s.fondo_inicial)}`, 14, 39);

  const esperado = s.esperado ?? {}, contado = s.contado ?? {}, diferencia = s.diferencia ?? {};
  const formas = Array.from(new Set([...Object.keys(esperado), ...Object.keys(contado)]));
  autoTable(doc, {
    startY: 44,
    head: [["Forma", "Esperado", "Contado", "Diferencia"]],
    body: formas.map((f) => [
      formaPagoLabel[f] ?? f,
      fmtMoney(Number(esperado[f]?.neto ?? 0)),
      fmtMoney(Number(contado[f] ?? 0)),
      fmtMoney(Number(diferencia[f] ?? 0)),
    ]),
    foot: [["TOTAL", fmtMoney(s.total_esperado), fmtMoney(s.total_contado), fmtMoney(s.total_diferencia)]],
    styles: { fontSize: 8 }, margin: { left: 14, right: 14 },
  });
  const y = (doc as any).lastAutoTable.finalY + 8;
  doc.setFontSize(10);
  doc.text(`Efectivo dejado para mañana: ${fmtMoney(s.efectivo_dejado ?? 0)}`, 14, y);
  if (s.notas) { doc.setFontSize(9); doc.text(`Observaciones: ${s.notas}`, 14, y + 6); }
  doc.save(`cierre-caja-${fmtDate(s.cerrada_en)}.pdf`);
}

function ArqueoPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucId, setSucId] = useState("");
  const effSucId = sucId || cu?.sucursal?.id || "";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("id,nombre").order("nombre")).data ?? []) as any[],
  });
  const sucNombre = useMemo(() => sucs.find((s: any) => s.id === effSucId)?.nombre ?? "", [sucs, effSucId]);

  // Sesión abierta de la sucursal (si hay).
  const { data: sesion, isLoading } = useQuery({
    queryKey: ["caja-sesion-activa", effSucId],
    enabled: !!effSucId,
    queryFn: async () => {
      const { data } = await supabase.from("caja_sesiones")
        .select("*")
        .eq("sucursal_id", effSucId).eq("estado", "ABIERTA")
        .order("abierta_en", { ascending: false }).limit(1).maybeSingle();
      return data as any;
    },
  });

  return (
    <div>
      <PageHeader
        title="Rendición de caja"
        subtitle="La caja se abre sola con la primera venta del día. Al cerrar, declarás lo contado y cuánto dejás para mañana."
        badge={sesion ? <StatusPill tone="success" icon={<LockOpen className="h-3 w-3" />}>Caja abierta</StatusPill>
                      : <StatusPill tone="neutral" icon={<Lock className="h-3 w-3" />}>Sin movimientos hoy</StatusPill>}
        actions={cu?.isAdmin && (
          <Select value={sucId} onValueChange={setSucId}>
            <SelectTrigger className="w-52"><SelectValue placeholder="Mi sucursal" /></SelectTrigger>
            <SelectContent>{sucs.map((s) => <SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>)}</SelectContent>
          </Select>
        )}
      />

      {isLoading ? (
        <SectionCard><p className="text-sm text-muted-foreground">Cargando…</p></SectionCard>
      ) : sesion ? (
        <CajaAbierta sesion={sesion} sucId={effSucId} onChange={() => {
          qc.invalidateQueries({ queryKey: ["caja-sesion-activa"] });
          qc.invalidateQueries({ queryKey: ["caja-historial"] });
        }} />
      ) : (
        <SectionCard title="Caja del día">
          <p className="text-sm text-muted-foreground">
            Todavía no hubo movimientos hoy en esta sucursal. La caja se abre sola con la primera venta,
            cobranza o pago; el fondo inicial es el efectivo que dejaste en el cierre anterior.
          </p>
        </SectionCard>
      )}

      <Historial sucId={effSucId} sucNombre={sucNombre} />
    </div>
  );
}

// ---------------- Caja abierta ----------------
function CajaAbierta({ sesion, sucId, onChange }: { sesion: any; sucId: string; onChange: () => void }) {
  const qc = useQueryClient();
  const [movOpen, setMovOpen] = useState(false);
  const [cerrarOpen, setCerrarOpen] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["caja-esperado", sesion.id] });
    qc.invalidateQueries({ queryKey: ["caja-movs", sesion.id] });
    onChange();
  };

  // Esperado en vivo por forma de pago: { forma: { entra, sale, neto } }.
  const { data: esperado = {} } = useQuery({
    queryKey: ["caja-esperado", sesion.id],
    queryFn: async () => {
      const { data } = await supabase.rpc("caja_esperado", { _sesion_id: sesion.id });
      return (data ?? {}) as Record<string, CajaForma>;
    },
  });

  const { data: movs = [] } = useQuery({
    queryKey: ["caja-movs", sesion.id],
    queryFn: async () => ((await supabase.from("caja_movimientos")
      .select("*").eq("caja_sesion_id", sesion.id).order("created_at")).data ?? []) as any[],
  });

  const totalEsperado = useMemo(
    () => FORMAS.reduce((a, f) => a + neto(esperado[f]), 0),
    [esperado],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {FORMAS.filter((f) => neto(esperado[f]) !== 0 || Number(esperado[f]?.sale ?? 0) !== 0 || f === "EFECTIVO").map((f) => (
          <SectionCard key={f} className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{formaPagoLabel[f]}</span>
              <Wallet className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="text-xl font-bold tabular-nums mt-1">{fmtMoney(neto(esperado[f]))}</div>
            <div className="text-[11px] text-muted-foreground flex gap-2">
              <span className="text-success">+{fmtMoney(esperado[f]?.entra ?? 0)}</span>
              <span className="text-destructive">−{fmtMoney(esperado[f]?.sale ?? 0)}</span>
            </div>
          </SectionCard>
        ))}
      </div>

      <SectionCard
        title="Turno abierto"
        subtitle={`Fondo inicial ${fmtMoney(sesion.fondo_inicial)} · abierta ${fmtDateTime(sesion.abierta_en)}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setMovOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Movimiento
            </Button>
            <Button size="sm" onClick={() => setCerrarOpen(true)}>
              <Lock className="h-4 w-4 mr-1" /> Cerrar caja
            </Button>
          </div>
        }
      >
        <div className="flex items-baseline justify-between border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">Total esperado en caja</span>
          <span className="text-lg font-bold tabular-nums">{fmtMoney(totalEsperado)}</span>
        </div>
        {movs.length > 0 && (
          <Table className="mt-3">
            <TableHeader><TableRow>
              <TableHead>Movimiento</TableHead><TableHead>Forma</TableHead>
              <TableHead className="text-right">Monto</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {movs.map((m) => {
                const sale = m.tipo === "GASTO" || m.tipo === "RETIRO";
                return (
                  <TableRow key={m.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        {sale ? <TrendingDown className="h-3.5 w-3.5 text-destructive" /> : <TrendingUp className="h-3.5 w-3.5 text-success" />}
                        {TIPO_MOV_LABEL[m.tipo] ?? m.tipo}
                      </span>
                      <span className="text-muted-foreground text-xs ml-1.5">{m.descripcion}</span>
                    </TableCell>
                    <TableCell className="text-xs">{formaPagoLabel[m.forma_pago]}</TableCell>
                    <TableCell className={`text-right font-mono tabular-nums ${sale ? "text-destructive" : ""}`}>
                      {sale ? "−" : "+"}{fmtMoney(m.monto)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      {movOpen && <MovimientoDialog sesionId={sesion.id} onClose={() => setMovOpen(false)} onSaved={() => { setMovOpen(false); invalidate(); }} />}
      {cerrarOpen && <CerrarDialog sesion={sesion} esperado={esperado} onClose={() => setCerrarOpen(false)} onClosed={() => { setCerrarOpen(false); invalidate(); }} />}
    </div>
  );
}

// ---------------- Movimiento manual ----------------
function MovimientoDialog({ sesionId, onClose, onSaved }: { sesionId: string; onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState("GASTO");
  const [forma, setForma] = useState("EFECTIVO");
  const [monto, setMonto] = useState<number | null>(null);
  const [desc, setDesc] = useState("");
  const m = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("registrar_movimiento_caja", {
        p_sesion_id: sesionId, p_tipo: tipo as any, p_forma_pago: forma as any,
        p_monto: Number(monto || 0), p_descripcion: desc,
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Movimiento registrado"); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Registrar movimiento de caja</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GASTO">Gasto (sale plata)</SelectItem>
                  <SelectItem value="RETIRO">Retiro a tesorería</SelectItem>
                  <SelectItem value="INGRESO">Ingreso (entra plata)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Forma</Label>
              <Select value={forma} onValueChange={setForma}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{FORMAS.map((f) => <SelectItem key={f} value={f}>{formaPagoLabel[f]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>Monto</Label>
            <NumberInput value={monto} onValueChange={setMonto} className="mt-1" />
          </div>
          <div>
            <Label>Descripción (para qué fue)</Label>
            <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ej: flete, pago proveedor, retiro al banco" className="mt-1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !monto || !desc.trim()}>Registrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Cierre con conteo ----------------
function CerrarDialog({ sesion, esperado, onClose, onClosed }:
  { sesion: any; esperado: Record<string, CajaForma>; onClose: () => void; onClosed: () => void }) {
  const [contado, setContado] = useState<Record<string, number | null>>({});
  const [notas, setNotas] = useState("");
  const [efectivoDejado, setEfectivoDejado] = useState<number | null>(null);

  const cerrar = useMutation({
    mutationFn: async () => {
      // R11: sólo el EFECTIVO se cuenta a mano (es lo único físico que puede
      // diferir). El resto de las formas se cierra con el monto ESPERADO por el
      // sistema, así su diferencia es siempre 0 por construcción.
      const payload: Record<string, number> = {};
      for (const f of FORMAS) {
        payload[f] = f === "EFECTIVO" ? Number(contado.EFECTIVO ?? 0) : neto(esperado[f]);
      }
      const { error } = await supabase.rpc("cerrar_caja", {
        p_sesion_id: sesion.id, p_contado: payload, p_notas: notas || undefined,
        p_efectivo_dejado: Number(efectivoDejado || 0),
      });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Caja cerrada"); onClosed(); },
    onError: (e: any) => toast.error(e.message),
  });

  // Todas las formas: además de contar lo esperado, el cajero puede declarar un
  // sobrante en una forma que el sistema esperaba en cero.
  const formasCierre = FORMAS;

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cerrar caja — conteo</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Contá el <strong>efectivo</strong> que hay físicamente en la caja. El resto de las formas ya viene con el monto
          esperado por el sistema (lo que entró menos lo que salió: compras, pagos a proveedor, gastos), no se cuenta a mano.
        </p>
        <div className="space-y-2 mt-1">
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center text-xs text-muted-foreground font-medium px-1">
            <span>Forma</span><span className="w-24 text-right">Esperado</span><span className="w-28 text-right">Contado</span><span className="w-24 text-right">Diferencia</span>
          </div>
          {formasCierre.map((f) => {
            const esp = neto(esperado[f]);
            const esEfectivo = f === "EFECTIVO";
            // Sólo el efectivo es editable. El resto muestra (y cierra con) el esperado.
            const cont = esEfectivo ? contado[f] : esp;
            const dif = esEfectivo ? (contado[f] == null ? null : Number(contado[f]) - esp) : 0;
            return (
              <div key={f} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-center">
                <span className="text-sm">{formaPagoLabel[f]}</span>
                <span className="w-24 text-right font-mono tabular-nums text-sm text-muted-foreground">{fmtMoney(esp)}</span>
                <div className="w-28">
                  <NumberInput
                    value={esEfectivo ? (contado[f] ?? null) : esp}
                    onValueChange={(v) => { if (esEfectivo) setContado((c) => ({ ...c, [f]: v })); }}
                    disabled={!esEfectivo}
                    className={`h-8 text-right ${!esEfectivo ? "opacity-60" : ""}`}
                  />
                </div>
                <span className={`w-24 text-right font-mono tabular-nums text-sm ${
                  dif == null ? "text-muted-foreground" : dif === 0 ? "text-success" : "text-destructive"
                }`}>
                  {dif == null ? "—" : `${dif > 0 ? "+" : ""}${fmtMoney(dif)}`}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
          <Label className="font-medium">Efectivo que dejás en la caja para mañana</Label>
          <div className="flex items-center gap-2 mt-1">
            <NumberInput value={efectivoDejado ?? null} onValueChange={setEfectivoDejado} className="h-9 w-40 text-right" />
            <p className="text-[11px] text-muted-foreground">
              Será el fondo inicial del próximo turno. El resto del efectivo se retira. Si no dejás nada, poné 0.
            </p>
          </div>
        </div>
        <div className="mt-2">
          <Label>Observaciones</Label>
          <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} className="mt-1"
            placeholder="Ej: faltante justificado por vuelto mal dado" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => cerrar.mutate()} disabled={cerrar.isPending}>
            <Lock className="h-4 w-4 mr-1" /> Confirmar cierre
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- Historial ----------------
function Historial({ sucId, sucNombre }: { sucId: string; sucNombre: string }) {
  const { data: sesiones = [] } = useQuery({
    queryKey: ["caja-historial", sucId],
    enabled: !!sucId,
    queryFn: async () => ((await supabase.from("caja_sesiones")
      .select("*").eq("sucursal_id", sucId).eq("estado", "CERRADA")
      .order("cerrada_en", { ascending: false }).limit(20)).data ?? []) as any[],
  });

  if (!sesiones.length) return null;
  return (
    <SectionCard title="Cierres anteriores" className="mt-4">
      <Table>
        <TableHeader><TableRow>
          <TableHead>Abierta</TableHead><TableHead>Cerrada</TableHead>
          <TableHead className="text-right">Esperado</TableHead>
          <TableHead className="text-right">Contado</TableHead>
          <TableHead className="text-right">Diferencia</TableHead>
          <TableHead className="text-right">Dejado</TableHead>
          <TableHead></TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {sesiones.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="text-xs">{fmtDateTime(s.abierta_en)}</TableCell>
              <TableCell className="text-xs">{fmtDateTime(s.cerrada_en)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtMoney(s.total_esperado)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtMoney(s.total_contado)}</TableCell>
              <TableCell className={`text-right font-mono tabular-nums ${
                Number(s.total_diferencia) === 0 ? "text-success" : "text-destructive"
              }`}>
                {Number(s.total_diferencia) > 0 ? "+" : ""}{fmtMoney(s.total_diferencia)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{fmtMoney(s.efectivo_dejado ?? 0)}</TableCell>
              <TableCell className="text-right">
                <Button size="sm" variant="ghost" onClick={() => pdfCierre(s, sucNombre)} title="Descargar PDF del cierre">
                  <Printer className="h-3.5 w-3.5" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
