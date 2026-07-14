/** Cuenta Corriente: lista clientes habilitados, su deuda y permite cobrar. */
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney, fmtDate, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { toast } from "sonner";
import { Wallet, Receipt } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { registrarCobranza } from "@/lib/cobranzas.functions";

export const Route = createFileRoute("/_authenticated/cuentas-corrientes")({
  component: CtaCtePage,
});

function CtaCtePage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<any>(null);
  const [openPago, setOpenPago] = useState(false);

  // Saldos por cliente, derivados del libro de movimientos (Σ débitos − Σ créditos).
  // Una sola consulta a la vista: no se recalcula sumando ventas y cobranzas.
  const { data: saldos = [] } = useQuery({
    queryKey: ["ctacte-saldos"],
    queryFn: async () => ((await supabase.from("cuenta_corriente_saldos")
      .select("*").order("razon_social")).data ?? []) as any[],
  });

  const filtered = useMemo(() => saldos.filter((c: any) =>
    !q || `${c.razon_social} ${c.cuit_dni ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [saldos, q]);

  return (
    <div>
      <PageHeader title="Cuentas Corrientes" subtitle="Deuda por cliente y registro de cobros." />

      <Card className="p-3 mb-4">
        <Input placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </Card>

      <DataTable
        columns={["Cliente", "CUIT/DNI", "Debe", "Pagado", "Saldo", ""]}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay clientes con cuenta corriente.", icon: <Wallet className="h-7 w-7" /> }}
      >
        {filtered.map((c: any) => {
          const saldo = Number(c.saldo);
          return (
            <TableRow key={c.cliente_id}>
              <TableCell className="font-medium">{c.razon_social}</TableCell>
              <TableCell className="font-mono text-xs">{c.cuit_dni ?? "—"}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(c.total_debe)}</TableCell>
              <TableCell className="text-right font-mono text-success">{fmtMoney(c.total_pagado)}</TableCell>
              <TableCell className={`text-right font-mono font-semibold ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : "text-muted-foreground"}`}>
                {fmtMoney(saldo)}{saldo < -0.01 && " (a favor)"}
              </TableCell>
              <TableCell>
                <Button size="sm" variant="outline" onClick={() => setSel({ id: c.cliente_id, razon_social: c.razon_social, cuit_dni: c.cuit_dni })}>
                  <Receipt className="h-3.5 w-3.5 mr-1" /> Ver
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>

      {sel && (
        <DetalleCliente cliente={sel} onClose={() => setSel(null)}
          onPagar={() => setOpenPago(true)} />
      )}
      {sel && (
        <PagoDialog open={openPago} onClose={() => setOpenPago(false)} cliente={sel}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["ctacte-saldos"] }); qc.invalidateQueries({ queryKey: ["ctacte-cliente", sel.id] }); setOpenPago(false); }} />
      )}
    </div>
  );
}

function DetalleCliente({ cliente, onClose, onPagar }: any) {
  // Extracto: el libro de movimientos del cliente (débitos y créditos), cronológico.
  const { data: movs = [] } = useQuery({
    queryKey: ["ctacte-cliente", cliente.id],
    queryFn: async () => ((await supabase.from("cuenta_corriente_movimientos")
      .select("id, created_at, tipo, monto, estado, forma_pago, descripcion, sucursal:sucursales(nombre)")
      .eq("cliente_id", cliente.id)
      .order("created_at", { ascending: false })).data ?? []) as any[],
  });

  // Saldo = Σ débitos − Σ créditos, sobre los confirmados.
  const confirmados = movs.filter((m: any) => m.estado === "CONFIRMADO");
  const totalDebe = confirmados.filter((m: any) => m.tipo === "DEBITO").reduce((a: number, m: any) => a + Number(m.monto), 0);
  const totalPagado = confirmados.filter((m: any) => m.tipo === "CREDITO").reduce((a: number, m: any) => a + Number(m.monto), 0);
  const saldo = totalDebe - totalPagado;

  return (
    <Dialog open={true} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>{cliente.razon_social}</span>
            <Button size="sm" onClick={onPagar}><Wallet className="h-4 w-4 mr-1" /> Registrar pago</Button>
          </DialogTitle>
        </DialogHeader>
        <SectionCard title="Resumen de la cuenta">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Debe</div>
              <div className="font-mono font-bold text-lg">{fmtMoney(totalDebe)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pagado</div>
              <div className="font-mono font-bold text-lg text-success">{fmtMoney(totalPagado)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Saldo</div>
              <div className={`font-mono font-bold text-lg ${saldo > 0.01 ? "text-destructive" : saldo < -0.01 ? "text-success" : ""}`}>
                {fmtMoney(saldo)}{saldo < -0.01 && " a favor"}
              </div>
            </div>
          </div>
        </SectionCard>

        <h4 className="font-semibold">Movimientos de la cuenta</h4>
        <DataTable
          columns={["Fecha", "Detalle", "Sucursal", "Debe", "Haber"]}
          isEmpty={movs.length === 0}
          empty={{ text: "Sin movimientos" }}
        >
          {movs.map((m: any) => {
            const anulado = m.estado === "ANULADO";
            return (
              <TableRow key={m.id} className={anulado ? "opacity-40 line-through" : ""}>
                <TableCell className="text-xs">{fmtDate(m.created_at)}</TableCell>
                <TableCell className="text-sm">
                  {m.descripcion}
                  {m.forma_pago && <span className="text-xs text-muted-foreground"> · {formaPagoLabel[m.forma_pago] ?? m.forma_pago}</span>}
                  {anulado && <span className="ml-2"><StatusPill tone="neutral">anulado</StatusPill></span>}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">{m.sucursal?.nombre}</TableCell>
                <TableCell className="text-right font-mono">{m.tipo === "DEBITO" ? fmtMoney(m.monto) : "—"}</TableCell>
                <TableCell className="text-right font-mono text-success">{m.tipo === "CREDITO" ? fmtMoney(m.monto) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </DataTable>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cerrar</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PagoDialog({ open, onClose, cliente, onSaved }: any) {
  const { data: cu } = useCurrentUser();
  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });
  const [sucId, setSucId] = useState<string>("");
  const [monto, setMonto] = useState<number | null>(null);
  const [forma, setForma] = useState<string>("EFECTIVO");
  const [detalle, setDetalle] = useState<Record<string, any>>({});
  const [obs, setObs] = useState("");
  const cobrarFn = useServerFn(registrarCobranza);

  const effSuc = sucId || cu?.sucursal?.id || "";
  const m = useMutation({
    mutationFn: async () => cobrarFn({
      data: {
        cliente_id: cliente.id, sucursal_id: effSuc,
        monto: Number(monto || 0), forma_pago: forma as any,
        detalle, observaciones: obs || null,
      },
    }),
    onSuccess: (r: any) => {
      const saldo = Number(r?.saldo ?? 0);
      toast.success(
        saldo < -0.01
          ? `Cobro registrado. Queda ${fmtMoney(Math.abs(saldo))} a favor del cliente.`
          : `Cobro registrado. Saldo: ${fmtMoney(saldo)}.`,
      );
      onSaved(); setMonto(null); setObs(""); setDetalle({});
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Registrar cobro · {cliente.razon_social}</DialogTitle></DialogHeader>
        <SectionCard title="Datos del cobro">
        <div className="grid grid-cols-2 gap-3">
          {cu?.isAdmin && (
            <div className="col-span-2"><Label>Sucursal (caja donde entra)</Label>
              <Select value={sucId} onValueChange={setSucId}>
                <SelectTrigger><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
                <SelectContent>{sucs.map((s: any) => (<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
              </Select>
            </div>
          )}
          <div><Label>Monto *</Label><NumberInput value={monto} onValueChange={setMonto} /></div>
          <div><Label>Forma de pago *</Label>
            <Select value={forma} onValueChange={setForma}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(formaPagoLabel).filter(([k]) => k !== "CTA_CTE").map(([k, l]) => (<SelectItem key={k} value={k}>{l}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          {forma === "CHEQUE" && (<>
            <div><Label>Banco</Label><Input value={detalle.banco ?? ""} onChange={(e) => setDetalle(d => ({ ...d, banco: e.target.value }))} /></div>
            <div><Label>Nro cheque</Label><Input value={detalle.numero ?? ""} onChange={(e) => setDetalle(d => ({ ...d, numero: e.target.value }))} /></div>
            <div><Label>Firmante</Label><Input value={detalle.firmante ?? ""} onChange={(e) => setDetalle(d => ({ ...d, firmante: e.target.value }))} /></div>
            <div><Label>Fecha cobro</Label><Input type="date" value={detalle.fecha_cobro ?? ""} onChange={(e) => setDetalle(d => ({ ...d, fecha_cobro: e.target.value }))} /></div>
          </>)}
          {forma === "TRANSFERENCIA" && (
            <div className="col-span-2"><Label>Banco / Cuenta</Label><Input value={detalle.banco ?? ""} onChange={(e) => setDetalle(d => ({ ...d, banco: e.target.value }))} /></div>
          )}
          <div className="col-span-2"><Label>Observaciones</Label>
            <Input value={obs} onChange={(e) => setObs(e.target.value)} />
          </div>
        </div>
        </SectionCard>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={!effSuc || !monto || monto <= 0 || m.isPending}>Registrar cobro</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
