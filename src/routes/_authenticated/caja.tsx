/** Cierre / Rendición de Caja al estilo del listado 3C:
 *  - Fondos por forma de pago (con detalle de comprobantes)
 *  - Detalle de Ventas y Cobranzas (Contado vs CtaCte)
 *  - Caja en efectivo: saldo inicial (efectivo dejado el día anterior) + ingresos del día - retirado = saldo final
 *  - Sin columna "declarado" ni "diferencia".
 */
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
import { TableRow, TableCell } from "@/components/ui/table";
import { NumberInput } from "@/components/ui/number-input";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { Printer, Save } from "lucide-react";
import { toast } from "sonner";
import { fmtMoney, fmtDate, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/caja")({
  component: CajaPage,
});

const FORMAS = ["EFECTIVO", "TRANSFERENCIA", "TARJETA_DEBITO", "TARJETA_CREDITO", "MERCADO_PAGO", "CHEQUE"] as const;

function CajaPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucId, setSucId] = useState("");
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [efectivoRetirado, setEfectivoRetirado] = useState<number | null>(0);
  const [obs, setObs] = useState("");

  const effSucId = sucId || cu?.sucursal?.id || "";

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });
  const sucNombre = useMemo(() => sucs.find((s: any) => s.id === effSucId)?.nombre ?? "", [sucs, effSucId]);

  const range = useMemo(() => {
    const start = new Date(fecha + "T00:00:00").toISOString();
    const end = new Date(fecha + "T23:59:59.999").toISOString();
    return { start, end };
  }, [fecha]);

  // Ventas + pagos del día
  const { data: ventasDia = [] } = useQuery({
    queryKey: ["caja-ventas", effSucId, fecha],
    enabled: !!effSucId,
    queryFn: async () => {
      const { data } = await supabase.from("ventas")
        .select("id, fecha, numero_comprobante, tipo_comprobante, condicion_venta, total, estado, cliente:clientes(razon_social, cuit_dni), pagos:venta_pagos(forma_pago, monto, detalle)")
        .eq("sucursal_id", effSucId).eq("estado", "ACTIVA")
        .gte("fecha", range.start).lte("fecha", range.end)
        .order("fecha");
      return (data ?? []) as any[];
    },
  });

  // Cobranzas Cta Cte del día (entran a caja)
  const { data: cobranzasDia = [] } = useQuery({
    queryKey: ["caja-cobranzas", effSucId, fecha],
    enabled: !!effSucId,
    queryFn: async () => {
      const { data } = await supabase.from("cobranzas_cta_cte")
        .select("id, fecha, monto, forma_pago, detalle, observaciones, cliente:clientes(razon_social)")
        .eq("sucursal_id", effSucId)
        .gte("fecha", range.start).lte("fecha", range.end)
        .order("fecha");
      return (data ?? []) as any[];
    },
  });

  // Saldo inicial: efectivo dejado por la rendición del día anterior en la MISMA sucursal
  const { data: rendicionAyer } = useQuery({
    queryKey: ["rendicion-ayer", effSucId, fecha],
    enabled: !!effSucId,
    queryFn: async () => {
      const d = new Date(fecha); d.setDate(d.getDate() - 1);
      const yesterday = d.toISOString().slice(0, 10);
      const { data } = await supabase.from("rendiciones_caja")
        .select("efectivo_dejado").eq("sucursal_id", effSucId).eq("fecha", yesterday)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data;
    },
  });
  const saldoInicialEfectivo = Number(rendicionAyer?.efectivo_dejado ?? 0);

  // Totales por forma de pago.
  //
  // Los pagos se guardan YA CON SIGNO: la devolución de una nota de crédito entra
  // como monto negativo, así que basta con sumar. Antes acá había un hack que
  // invertía el signo al leer, y tenía dos bugs: sólo lo aplicaba al EFECTIVO (una
  // nota de crédito devuelta por transferencia SUMABA a la caja en vez de restar),
  // y también invertía las notas de DÉBITO, que son un cargo extra y deben sumar.
  const totalesSistema = useMemo(() => {
    const t: Record<string, number> = Object.fromEntries(FORMAS.map(f => [f, 0]));
    ventasDia.forEach((v: any) => {
      (v.pagos ?? []).forEach((p: any) => {
        if (t[p.forma_pago] !== undefined) t[p.forma_pago] += Number(p.monto);
      });
    });
    cobranzasDia.forEach((c: any) => { if (t[c.forma_pago] !== undefined) t[c.forma_pago] += Number(c.monto); });
    return t;
  }, [ventasDia, cobranzasDia]);

  const totalSistema = Object.values(totalesSistema).reduce((a, b) => a + b, 0);
  const efectivoFinal = saldoInicialEfectivo + totalesSistema.EFECTIVO - Number(efectivoRetirado || 0);

  // Ventas contado vs cta cte
  const ventasContado = ventasDia.filter((v: any) => v.condicion_venta === "CONTADO");
  const ventasCtaCte = ventasDia.filter((v: any) => v.condicion_venta === "CTA_CTE");

  const { data: historial = [] } = useQuery({
    queryKey: ["rendiciones-hist", effSucId],
    enabled: !!effSucId,
    queryFn: async () => ((await supabase.from("rendiciones_caja")
      .select("*").eq("sucursal_id", effSucId).order("fecha", { ascending: false }).limit(20)).data ?? []) as any[],
  });

  const guardar = useMutation({
    mutationFn: async () => {
      const payload = {
        sucursal_id: effSucId, fecha, usuario_id: cu!.user.id,
        saldo_inicial: saldoInicialEfectivo,
        total_efectivo: totalesSistema.EFECTIVO,
        total_transferencia: totalesSistema.TRANSFERENCIA,
        total_debito: totalesSistema.TARJETA_DEBITO,
        total_credito: totalesSistema.TARJETA_CREDITO,
        total_mp: totalesSistema.MERCADO_PAGO,
        total_cheque: totalesSistema.CHEQUE,
        total_cta_cte: ventasCtaCte.reduce((a: number, v: any) => a + Number(v.total), 0),
        total_sistema: totalSistema,
        total_declarado: totalSistema,
        diferencia: 0,
        efectivo_retirado: Number(efectivoRetirado || 0),
        efectivo_dejado: efectivoFinal,
        observaciones: obs,
      };
      const { error } = await supabase.from("rendiciones_caja").upsert(payload, { onConflict: "sucursal_id,fecha,usuario_id" });
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Rendición guardada"); qc.invalidateQueries({ queryKey: ["rendiciones-hist"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const imprimir = () => {
    const doc = new jsPDF();
    const W = doc.internal.pageSize.getWidth();
    doc.setFontSize(13); doc.text("CASAFORMA", 14, 14);
    doc.setFontSize(11); doc.text(`Rendición del ${fmtDate(fecha)}`, W / 2, 14, { align: "center" });
    doc.setFontSize(9); doc.text(`Sucursal: ${sucNombre}`, W / 2, 19, { align: "center" });

    // FONDOS por forma de pago (cuenta + detalle)
    let y = 26;
    doc.setFontSize(11); doc.setFont(undefined as any, "bold"); doc.text("Fondos", W / 2, y, { align: "center" });
    y += 4;

    FORMAS.forEach((f) => {
      const items: any[] = [];
      ventasDia.forEach((v: any) => {
        (v.pagos ?? []).forEach((p: any) => { if (p.forma_pago === f) items.push({ tipo: "V", v, monto: Number(p.monto), detalle: p.detalle }); });
      });
      cobranzasDia.forEach((c: any) => { if (c.forma_pago === f) items.push({ tipo: "C", c, monto: Number(c.monto) }); });
      if (items.length === 0 && totalesSistema[f] === 0) return;

      autoTable(doc, {
        startY: y,
        head: [[formaPagoLabel[f], "", "", { content: "Importe", styles: { halign: "right" } }]],
        body: items.map((it: any) => it.tipo === "V"
          ? [it.v.numero_comprobante, it.v.cliente?.razon_social ?? "", it.v.cliente?.cuit_dni ?? "", { content: fmtMoney(it.monto), styles: { halign: "right" } }]
          : ["Cobranza", it.c.cliente?.razon_social ?? "", "", { content: fmtMoney(it.monto), styles: { halign: "right" } }]),
        foot: [["Total", "", "", { content: fmtMoney(totalesSistema[f]), styles: { halign: "right", fontStyle: "bold" } }]],
        styles: { fontSize: 7 }, theme: "striped", margin: { left: 14, right: 14 },
      });
      y = (doc as any).lastAutoTable.finalY + 4;
    });

    // Total general
    autoTable(doc, {
      startY: y,
      body: [["TOTAL GENERAL", { content: fmtMoney(totalSistema), styles: { halign: "right", fontStyle: "bold" } }]],
      theme: "grid", styles: { fontSize: 9 }, margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 6;

    // Caja en efectivo
    autoTable(doc, {
      startY: y,
      head: [["Caja en efectivo", ""]],
      body: [
        ["Saldo inicial (efectivo dejado día anterior)", { content: fmtMoney(saldoInicialEfectivo), styles: { halign: "right" } }],
        ["+ Ingresos en efectivo del día", { content: fmtMoney(totalesSistema.EFECTIVO), styles: { halign: "right" } }],
        ["- Efectivo retirado", { content: fmtMoney(Number(efectivoRetirado || 0)), styles: { halign: "right" } }],
        ["= Efectivo dejado (saldo inicial mañana)", { content: fmtMoney(efectivoFinal), styles: { halign: "right", fontStyle: "bold" } }],
      ],
      styles: { fontSize: 9 }, margin: { left: 14, right: 14 },
    });
    y = (doc as any).lastAutoTable.finalY + 6;

    // Ventas Contado
    if (ventasContado.length) {
      doc.addPage(); y = 14;
      doc.setFontSize(11); doc.text("Detalle Ventas Contado", W / 2, y, { align: "center" }); y += 4;
      autoTable(doc, {
        startY: y,
        head: [["Fecha", "Tipo", "Número", "Cliente", { content: "Total", styles: { halign: "right" } }]],
        body: ventasContado.map((v: any) => [fmtDate(v.fecha), tipoComprobanteLabel[v.tipo_comprobante], v.numero_comprobante, v.cliente?.razon_social ?? "", { content: fmtMoney(v.total), styles: { halign: "right" } }]),
        foot: [["", "", "", "Total Contado", { content: fmtMoney(ventasContado.reduce((a: number, v: any) => a + Number(v.total), 0)), styles: { halign: "right", fontStyle: "bold" } }]],
        styles: { fontSize: 8 }, margin: { left: 14, right: 14 },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }

    // Ventas Cta Cte
    if (ventasCtaCte.length) {
      autoTable(doc, {
        startY: y,
        head: [["Fecha", "Tipo", "Número", "Cliente", { content: "Total", styles: { halign: "right" } }]],
        body: ventasCtaCte.map((v: any) => [fmtDate(v.fecha), tipoComprobanteLabel[v.tipo_comprobante], v.numero_comprobante, v.cliente?.razon_social ?? "", { content: fmtMoney(v.total), styles: { halign: "right" } }]),
        foot: [["", "", "", "Total Cta Cte", { content: fmtMoney(ventasCtaCte.reduce((a: number, v: any) => a + Number(v.total), 0)), styles: { halign: "right", fontStyle: "bold" } }]],
        styles: { fontSize: 8 }, margin: { left: 14, right: 14 },
        didDrawPage: () => { doc.setFontSize(11); doc.text("Detalle Ventas Cuenta Corriente", W / 2, 12, { align: "center" }); },
      });
    }

    if (obs) {
      y = (doc as any).lastAutoTable.finalY + 6;
      doc.setFontSize(9); doc.text(`Obs: ${obs}`, 14, y);
    }
    doc.save(`rendicion-${sucNombre}-${fecha}.pdf`);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Rendición de caja"
        subtitle="Cierre diario por sucursal · CasaForma"
        actions={
          <>
            <Button variant="outline" onClick={imprimir} disabled={!effSucId}><Printer className="h-4 w-4 mr-1" /> PDF detallado</Button>
            <Button onClick={() => guardar.mutate()} disabled={!effSucId || guardar.isPending}><Save className="h-4 w-4 mr-1" /> Guardar</Button>
          </>
        }
      />

      <Card className="p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        {cu?.isAdmin && (
          <div><Label>Sucursal</Label>
            <Select value={sucId} onValueChange={setSucId}>
              <SelectTrigger><SelectValue placeholder="Seleccionar…" /></SelectTrigger>
              <SelectContent>{sucs.map((s: any) => (<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
        )}
        <div><Label>Fecha</Label><Input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="font-semibold mb-3">Totales por forma de pago</h3>
          <DataTable columns={["Forma", "Importe"]}>
            {FORMAS.map(f => (
              <TableRow key={f}>
                <TableCell>{formaPagoLabel[f]}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(totalesSistema[f])}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-bold border-t-2 border-border">
              <TableCell>TOTAL DEL DÍA</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(totalSistema)}</TableCell>
            </TableRow>
          </DataTable>
        </div>

        <SectionCard title="Caja en efectivo">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span>Saldo inicial (efectivo dejado ayer):</span>
              <span className="font-mono">{fmtMoney(saldoInicialEfectivo)}</span>
            </div>
            <div className="flex justify-between text-success">
              <span>+ Ingresos en efectivo:</span>
              <span className="font-mono">{fmtMoney(totalesSistema.EFECTIVO)}</span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <Label className="m-0">– Efectivo retirado:</Label>
              <NumberInput value={efectivoRetirado} onValueChange={setEfectivoRetirado} className="h-8 w-32 text-right" />
            </div>
            <div className="flex justify-between text-lg font-bold border-t border-border pt-2">
              <span>= Efectivo dejado (saldo inicial mañana):</span>
              <span className="font-mono">{fmtMoney(efectivoFinal)}</span>
            </div>
          </div>
          <div className="mt-4">
            <Label>Observaciones</Label>
            <Textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} />
          </div>
        </SectionCard>
      </div>

      <div>
        <h3 className="font-semibold mb-3">Ventas del día — Contado ({ventasContado.length})</h3>
        <DataTable
          columns={["Tipo", "Número", "Cliente", "Total"]}
          isEmpty={ventasContado.length === 0}
          empty={{ text: "Sin ventas de contado en el día." }}
        >
          {ventasContado.map((v: any) => (
            <TableRow key={v.id}>
              <TableCell className="text-xs">{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
              <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
              <TableCell>{v.cliente?.razon_social}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
            </TableRow>
          ))}
        </DataTable>
      </div>

      {ventasCtaCte.length > 0 && (
        <div>
          <h3 className="font-semibold mb-3">Ventas del día — Cuenta Corriente ({ventasCtaCte.length})</h3>
          <DataTable columns={["Tipo", "Número", "Cliente", "Total"]}>
            {ventasCtaCte.map((v: any) => (
              <TableRow key={v.id}>
                <TableCell className="text-xs">{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
                <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                <TableCell>{v.cliente?.razon_social}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </div>
      )}

      {cobranzasDia.length > 0 && (
        <div>
          <h3 className="font-semibold mb-3">Cobranzas Cta Cte del día ({cobranzasDia.length})</h3>
          <DataTable columns={["Cliente", "Forma", "Monto"]}>
            {cobranzasDia.map((c: any) => (
              <TableRow key={c.id}>
                <TableCell>{c.cliente?.razon_social}</TableCell>
                <TableCell className="text-xs">{formaPagoLabel[c.forma_pago]}</TableCell>
                <TableCell className="text-right font-mono text-success">{fmtMoney(c.monto)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </div>
      )}

      <div>
        <h3 className="font-semibold mb-3">Historial</h3>
        <DataTable
          columns={["Fecha", "Total día", "Efectivo retirado", "Efectivo dejado"]}
          isEmpty={historial.length === 0}
          empty={{ text: "Sin rendiciones registradas." }}
        >
          {historial.map((h: any) => (
            <TableRow key={h.id}>
              <TableCell>{fmtDate(h.fecha)}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(h.total_sistema)}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(h.efectivo_retirado)}</TableCell>
              <TableCell className="text-right font-mono">{fmtMoney(h.efectivo_dejado)}</TableCell>
            </TableRow>
          ))}
        </DataTable>
      </div>
    </div>
  );
}
