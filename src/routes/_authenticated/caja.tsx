import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Printer } from "lucide-react";
import { toast } from "sonner";
import { fmtMoney, fmtDate } from "@/lib/format";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/caja")({
  component: CajaPage,
});

function CajaPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucId, setSucId] = useState("");
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0,10));
  const [saldoInicial, setSaldoInicial] = useState(0);
  const [declarados, setDeclarados] = useState<Record<string, number>>({
    EFECTIVO: 0, TRANSFERENCIA: 0, TARJETA_DEBITO: 0, TARJETA_CREDITO: 0, MERCADO_PAGO: 0, CHEQUE: 0, CTA_CTE: 0,
  });
  const [obs, setObs] = useState("");

  const effSucId = sucId || cu?.sucursal?.id || "";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });

  const { data: pagosDia = [] } = useQuery({
    queryKey: ["pagos-dia", effSucId, fecha],
    enabled: !!effSucId,
    queryFn: async () => {
      const start = new Date(fecha + "T00:00:00").toISOString();
      const end = new Date(fecha + "T23:59:59.999").toISOString();
      const { data } = await supabase.from("venta_pagos")
        .select(`monto, forma_pago, venta:ventas!inner(sucursal_id, fecha, estado)`)
        .eq("venta.sucursal_id", effSucId).eq("venta.estado", "ACTIVA")
        .gte("venta.fecha", start).lte("venta.fecha", end);
      return (data ?? []) as any[];
    },
  });

  const totalesSistema = useMemo(() => {
    const t: Record<string, number> = { EFECTIVO: 0, TRANSFERENCIA: 0, TARJETA_DEBITO: 0, TARJETA_CREDITO: 0, MERCADO_PAGO: 0, CHEQUE: 0, CTA_CTE: 0 };
    pagosDia.forEach((p:any) => { t[p.forma_pago] = (t[p.forma_pago] ?? 0) + Number(p.monto); });
    return t;
  }, [pagosDia]);

  const totalSistema = Object.values(totalesSistema).reduce((a,b)=>a+b,0);
  const totalDeclarado = Object.values(declarados).reduce((a,b)=>a+b,0);
  const diferencia = totalDeclarado - totalSistema;

  const { data: historial = [] } = useQuery({
    queryKey: ["rendiciones", effSucId],
    enabled: !!effSucId,
    queryFn: async () => ((await supabase.from("rendiciones_caja").select("*, sucursal:sucursales(nombre)")
      .eq("sucursal_id", effSucId).order("fecha", { ascending: false }).limit(20)).data ?? []) as any[],
  });

  const m = useMutation({
    mutationFn: async () => {
      const payload = {
        sucursal_id: effSucId, fecha, usuario_id: cu!.user.id, saldo_inicial: saldoInicial,
        total_efectivo: totalesSistema.EFECTIVO, total_transferencia: totalesSistema.TRANSFERENCIA,
        total_debito: totalesSistema.TARJETA_DEBITO, total_credito: totalesSistema.TARJETA_CREDITO,
        total_mp: totalesSistema.MERCADO_PAGO, total_cheque: totalesSistema.CHEQUE, total_cta_cte: totalesSistema.CTA_CTE,
        total_sistema: totalSistema, total_declarado: totalDeclarado, diferencia, observaciones: obs,
      };
      const { error } = await supabase.from("rendiciones_caja").upsert(payload, { onConflict: "sucursal_id,fecha,usuario_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Rendición guardada"); qc.invalidateQueries({ queryKey: ["rendiciones"] }); },
    onError: (e:any) => toast.error(e.message),
  });

  const imprimir = () => {
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text("CasaForma — Rendición de caja", 14, 16);
    doc.setFontSize(10);
    doc.text(`Sucursal: ${sucs.find((s:any)=>s.id===effSucId)?.nombre ?? ""}   Fecha: ${fmtDate(fecha)}`, 14, 24);
    autoTable(doc, {
      startY: 30,
      head: [["Forma de pago","Sistema","Declarado","Diferencia"]],
      body: Object.keys(totalesSistema).map(k => [
        k.replace("_"," "), fmtMoney(totalesSistema[k]), fmtMoney(declarados[k] ?? 0),
        fmtMoney((declarados[k] ?? 0) - totalesSistema[k]),
      ]),
      foot: [["TOTAL", fmtMoney(totalSistema), fmtMoney(totalDeclarado), fmtMoney(diferencia)]],
    });
    if (obs) { const y = (doc as any).lastAutoTable.finalY + 8; doc.text(`Obs: ${obs}`, 14, y); }
    doc.save(`rendicion-${fecha}.pdf`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Rendición de caja</h1>
          <p className="text-sm text-muted-foreground">Cierre diario por sucursal</p>
        </div>
        <Button variant="outline" onClick={imprimir} disabled={!effSucId}><Printer className="h-4 w-4 mr-1"/> PDF</Button>
      </div>

      <Card className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        {cu?.isAdmin && (
          <div><Label>Sucursal</Label>
            <Select value={sucId} onValueChange={setSucId}>
              <SelectTrigger><SelectValue placeholder="Seleccionar…"/></SelectTrigger>
              <SelectContent>{sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
        )}
        <div><Label>Fecha</Label><Input type="date" value={fecha} onChange={(e)=>setFecha(e.target.value)}/></div>
        <div><Label>Saldo inicial</Label><Input type="number" step="0.01" value={saldoInicial} onChange={(e)=>setSaldoInicial(Number(e.target.value))}/></div>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-3">Totales por forma de pago</h3>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Forma</TableHead><TableHead className="text-right">Sistema</TableHead>
            <TableHead className="text-right">Declarado</TableHead><TableHead className="text-right">Diferencia</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {Object.keys(totalesSistema).map(k => {
              const dif = (declarados[k] ?? 0) - totalesSistema[k];
              return (
                <TableRow key={k}>
                  <TableCell>{k.replace("_", " ")}</TableCell>
                  <TableCell className="text-right font-mono">{fmtMoney(totalesSistema[k])}</TableCell>
                  <TableCell className="text-right">
                    <Input type="number" step="0.01" className="h-8 w-32 text-right ml-auto" value={declarados[k]}
                      onChange={(e)=>setDeclarados(d=>({ ...d, [k]: Number(e.target.value) }))}/>
                  </TableCell>
                  <TableCell className={`text-right font-mono ${dif === 0 ? "" : dif > 0 ? "text-success" : "text-destructive"}`}>{fmtMoney(dif)}</TableCell>
                </TableRow>
              );
            })}
            <TableRow className="font-bold border-t-2 border-border">
              <TableCell>TOTAL</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(totalSistema)}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(totalDeclarado)}</TableCell>
              <TableCell className={`text-right font-mono ${diferencia === 0 ? "" : diferencia > 0 ? "text-success" : "text-destructive"}`}>{fmtMoney(diferencia)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card className="p-4">
        <Label>Observaciones</Label>
        <Textarea value={obs} onChange={(e)=>setObs(e.target.value)} rows={2}/>
        <Button className="mt-3" onClick={()=>m.mutate()} disabled={!effSucId || m.isPending}>Guardar rendición</Button>
      </Card>

      <Card className="p-4">
        <h3 className="font-semibold mb-3">Historial de rendiciones</h3>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Fecha</TableHead><TableHead>Sucursal</TableHead>
            <TableHead className="text-right">Sistema</TableHead><TableHead className="text-right">Declarado</TableHead>
            <TableHead className="text-right">Diferencia</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {historial.map((h:any)=>(
              <TableRow key={h.id}>
                <TableCell>{fmtDate(h.fecha)}</TableCell>
                <TableCell className="text-muted-foreground">{h.sucursal?.nombre}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(h.total_sistema)}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(h.total_declarado)}</TableCell>
                <TableCell className={`text-right font-mono ${Number(h.diferencia) === 0 ? "" : Number(h.diferencia) > 0 ? "text-success" : "text-destructive"}`}>{fmtMoney(h.diferencia)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
