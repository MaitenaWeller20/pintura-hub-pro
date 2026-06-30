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
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
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

  // Clientes habilitados
  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-ctacte"],
    queryFn: async () => ((await supabase.from("clientes")
      .select("id, razon_social, cuit_dni, telefono, limite_credito")
      .eq("condicion_cta_cte", true).eq("activo", true)
      .order("razon_social")).data ?? []) as any[],
  });

  // Comprobantes a cuenta + cobranzas (resumen por cliente)
  const { data: resumen = {} } = useQuery({
    queryKey: ["ctacte-resumen"],
    queryFn: async () => {
      const [{ data: ventas }, { data: cobranzas }] = await Promise.all([
        supabase.from("ventas").select("cliente_id, total").eq("condicion_venta", "CTA_CTE").eq("estado", "ACTIVA"),
        supabase.from("cobranzas_cta_cte").select("cliente_id, monto"),
      ]);
      const map: Record<string, { debe: number; pagado: number }> = {};
      (ventas ?? []).forEach((v: any) => {
        map[v.cliente_id] = map[v.cliente_id] ?? { debe: 0, pagado: 0 };
        map[v.cliente_id].debe += Number(v.total);
      });
      (cobranzas ?? []).forEach((c: any) => {
        map[c.cliente_id] = map[c.cliente_id] ?? { debe: 0, pagado: 0 };
        map[c.cliente_id].pagado += Number(c.monto);
      });
      return map;
    },
  });

  const filtered = useMemo(() => clientes.filter((c: any) =>
    !q || `${c.razon_social} ${c.cuit_dni ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [clientes, q]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Cuentas Corrientes</h1>
        <p className="text-sm text-muted-foreground">Deuda por cliente y registro de cobros.</p>
      </div>

      <Card className="p-3">
        <Input placeholder="Buscar cliente…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </Card>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead><TableHead>CUIT/DNI</TableHead>
              <TableHead className="text-right">Debe</TableHead>
              <TableHead className="text-right">Pagado</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c: any) => {
              const r = (resumen as any)[c.id] ?? { debe: 0, pagado: 0 };
              const saldo = r.debe - r.pagado;
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.razon_social}</TableCell>
                  <TableCell className="font-mono text-xs">{c.cuit_dni ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono">{fmtMoney(r.debe)}</TableCell>
                  <TableCell className="text-right font-mono text-success">{fmtMoney(r.pagado)}</TableCell>
                  <TableCell className={`text-right font-mono font-semibold ${saldo > 0.01 ? "text-destructive" : "text-muted-foreground"}`}>{fmtMoney(saldo)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => setSel(c)}>
                      <Receipt className="h-3.5 w-3.5 mr-1" /> Ver
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-6">No hay clientes con cuenta corriente.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {sel && (
        <DetalleCliente cliente={sel} onClose={() => setSel(null)}
          onPagar={() => setOpenPago(true)} />
      )}
      {sel && (
        <PagoDialog open={openPago} onClose={() => setOpenPago(false)} cliente={sel}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["ctacte-resumen"] }); qc.invalidateQueries({ queryKey: ["ctacte-cliente", sel.id] }); setOpenPago(false); }} />
      )}
    </div>
  );
}

function DetalleCliente({ cliente, onClose, onPagar }: any) {
  const { data } = useQuery({
    queryKey: ["ctacte-cliente", cliente.id],
    queryFn: async () => {
      const [{ data: ventas }, { data: cobranzas }] = await Promise.all([
        supabase.from("ventas")
          .select("id, fecha, numero_comprobante, tipo_comprobante, total, nombre_obra, sucursal:sucursales(nombre)")
          .eq("cliente_id", cliente.id).eq("condicion_venta", "CTA_CTE").eq("estado", "ACTIVA")
          .order("fecha", { ascending: false }),
        supabase.from("cobranzas_cta_cte")
          .select("id, fecha, monto, forma_pago, observaciones, sucursal:sucursales(nombre)")
          .eq("cliente_id", cliente.id).order("fecha", { ascending: false }),
      ]);
      return { ventas: ventas ?? [], cobranzas: cobranzas ?? [] };
    },
  });

  const totalDebe = (data?.ventas ?? []).reduce((a: number, v: any) => a + Number(v.total), 0);
  const totalPagado = (data?.cobranzas ?? []).reduce((a: number, c: any) => a + Number(c.monto), 0);
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
        <div className="grid grid-cols-3 gap-3 text-sm">
          <Card className="p-3"><div className="text-xs text-muted-foreground">Debe</div><div className="font-mono font-bold">{fmtMoney(totalDebe)}</div></Card>
          <Card className="p-3"><div className="text-xs text-muted-foreground">Pagado</div><div className="font-mono font-bold text-success">{fmtMoney(totalPagado)}</div></Card>
          <Card className="p-3"><div className="text-xs text-muted-foreground">Saldo</div><div className={`font-mono font-bold ${saldo > 0.01 ? "text-destructive" : ""}`}>{fmtMoney(saldo)}</div></Card>
        </div>

        <h4 className="font-semibold mt-2">Comprobantes a cuenta</h4>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fecha</TableHead><TableHead>Tipo</TableHead><TableHead>Número</TableHead>
            <TableHead>Sucursal</TableHead><TableHead>Obra</TableHead><TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(data?.ventas ?? []).map((v: any) => (
              <TableRow key={v.id}>
                <TableCell>{fmtDate(v.fecha)}</TableCell>
                <TableCell><Badge variant="outline" className="text-xs">{tipoComprobanteLabel[v.tipo_comprobante] ?? v.tipo_comprobante}</Badge></TableCell>
                <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{v.sucursal?.nombre}</TableCell>
                <TableCell className="text-xs">{v.nombre_obra ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
              </TableRow>
            ))}
            {(data?.ventas ?? []).length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground text-sm">Sin comprobantes</TableCell></TableRow>}
          </TableBody>
        </Table>

        <h4 className="font-semibold mt-2">Cobranzas</h4>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fecha</TableHead><TableHead>Forma</TableHead><TableHead>Sucursal</TableHead>
            <TableHead>Obs.</TableHead><TableHead className="text-right">Monto</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(data?.cobranzas ?? []).map((c: any) => (
              <TableRow key={c.id}>
                <TableCell>{fmtDate(c.fecha)}</TableCell>
                <TableCell className="text-xs">{formaPagoLabel[c.forma_pago] ?? c.forma_pago}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{c.sucursal?.nombre}</TableCell>
                <TableCell className="text-xs">{c.observaciones ?? "—"}</TableCell>
                <TableCell className="text-right font-mono text-success">{fmtMoney(c.monto)}</TableCell>
              </TableRow>
            ))}
            {(data?.cobranzas ?? []).length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground text-sm">Sin cobranzas</TableCell></TableRow>}
          </TableBody>
        </Table>
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
    onSuccess: () => { toast.success("Cobro registrado"); onSaved(); setMonto(null); setObs(""); setDetalle({}); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Registrar cobro · {cliente.razon_social}</DialogTitle></DialogHeader>
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={!effSuc || !monto || monto <= 0 || m.isPending}>Registrar cobro</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
