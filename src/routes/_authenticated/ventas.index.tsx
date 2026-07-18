import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { SectionCard } from "@/components/app/section-card";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { Plus, Eye, Ban, Printer, FileSpreadsheet, FileCheck2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { anularVenta } from "@/lib/ventas.functions";
import { emitirComprobante, datosFiscalesComprobante } from "@/lib/fiscal.functions";
import { esComprobanteFiscal } from "@/lib/fiscal/codigos";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/ventas/")({
  component: VentasList,
});

function VentasList() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucFilter, setSucFilter] = useState("");
  const [pagoFilter, setPagoFilter] = useState("all");
  const [q, setQ] = useState("");
  const [verVenta, setVerVenta] = useState<any>(null);
  const [anularDlg, setAnularDlg] = useState<any>(null);
  const anularFn = useServerFn(anularVenta);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });

  const { data: ventas = [], isLoading: loadingVentas } = useQuery({
    queryKey: ["ventas", cu?.user.id, sucFilter, pagoFilter],
    enabled: !!cu,
    queryFn: async () => {
      let q = supabase.from("ventas").select(`
        *, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre,codigo)
      `).order("fecha", { ascending: false }).limit(200);
      if (sucFilter) q = q.eq("sucursal_id", sucFilter);
      if (pagoFilter !== "all") q = q.eq("estado_pago", pagoFilter as any);
      return (((await q).data) ?? []) as any[];
    },
  });

  const filtered = useMemo(() => ventas.filter((v:any) =>
    !q || `${v.numero_comprobante} ${v.cliente?.razon_social ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [ventas, q]);

  const anular = useMutation({
    mutationFn: async (id: string) => anularFn({ data: { venta_id: id } }),
    onSuccess: () => { toast.success("Venta anulada"); qc.invalidateQueries({ queryKey: ["ventas"] }); setAnularDlg(null); },
    onError: (e:any) => toast.error(e.message),
  });

  const emitirFn = useServerFn(emitirComprobante);
  const emitir = useMutation({
    mutationFn: async (id: string) => emitirFn({ data: { venta_id: id } }),
    onSuccess: (r: any) => {
      toast.success(
        r.recuperado
          ? `AFIP ya lo había autorizado. CAE ${r.cae} recuperado.`
          : `CAE ${r.cae} obtenido${r.modo === "HOMOLOGACION" ? " (homologación)" : ""}.`,
      );
      qc.invalidateQueries({ queryKey: ["ventas"] });
    },
    // Los errores de AFIP son largos y hay que poder leerlos.
    onError: (e: any) => toast.error(e.message, { duration: 12000 }),
  });

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(filtered.map((v:any) => ({
      Comprobante: v.numero_comprobante, Tipo: tipoComprobanteLabel[v.tipo_comprobante],
      Fecha: v.fecha, Sucursal: v.sucursal?.nombre, Cliente: v.cliente?.razon_social,
      Subtotal: v.subtotal_sin_iva, IVA: v.iva_total, Total: v.total, Pagado: v.total_pagado, Estado: v.estado_pago,
    })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ventas");
    XLSX.writeFile(wb, "ventas.xlsx");
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ventas"
        subtitle={`${filtered.length} comprobantes`}
        actions={
          <>
            <Button variant="outline" onClick={exportar}><FileSpreadsheet className="h-4 w-4 mr-1"/> Excel</Button>
            <Button asChild><Link to="/ventas/nueva"><Plus className="h-4 w-4 mr-1"/> Nueva venta</Link></Button>
          </>
        }
      />

      <SectionCard>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Buscar comprobante o cliente…" value={q} onChange={(e)=>setQ(e.target.value)} className="max-w-xs"/>
          {cu?.isAdmin && (
            <Select value={sucFilter || "__all__"} onValueChange={(v)=>setSucFilter(v==="__all__"?"":v)}>
              <SelectTrigger className="w-44"><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todas las sucursales</SelectItem>
                {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
              </SelectContent>
            </Select>
          )}
          <Select value={pagoFilter} onValueChange={setPagoFilter}>
            <SelectTrigger className="w-44"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los estados</SelectItem>
              <SelectItem value="PAGADO">Pagado</SelectItem>
              <SelectItem value="PARCIAL">Pago parcial</SelectItem>
              <SelectItem value="PENDIENTE">Pendiente</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </SectionCard>

      <DataTable
        columns={cu?.isAdmin
          ? ["Comprobante", "Tipo", "Fecha", "Cliente", "Sucursal", "Total", "Estado", "AFIP", ""]
          : ["Comprobante", "Tipo", "Fecha", "Cliente", "Total", "Estado", "AFIP", ""]}
        loading={loadingVentas}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay comprobantes para este filtro.", icon: <FileSpreadsheet className="h-7 w-7" /> }}
      >
        {filtered.map((v:any) => (
          <TableRow key={v.id} className={v.estado === "ANULADA" ? "opacity-50" : ""}>
            <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
            <TableCell>{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
            <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
            <TableCell>{v.cliente?.razon_social}</TableCell>
            {cu?.isAdmin && <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>}
            <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
            <TableCell>
              {v.estado === "ANULADA" ? <StatusPill tone="danger">ANULADA</StatusPill>
                : v.tipo_comprobante === "NOTA_CREDITO" ? <StatusPill tone="neutral">N. Crédito</StatusPill>
                : v.condicion_venta === "CTA_CTE" ? <StatusPill tone="info">Cta Cte</StatusPill>
                : (
                <StatusPill tone={v.estado_pago === "PAGADO" ? "success" : "warning"}>
                  {v.estado_pago}
                </StatusPill>
              )}
            </TableCell>
            <TableCell><EstadoAfip venta={v} /></TableCell>
            <TableCell>
              <Button size="sm" variant="ghost" onClick={()=>setVerVenta(v)}><Eye className="h-3.5 w-3.5"/></Button>
              {/* Sólo se factura lo que es un comprobante fiscal. Los remitos y la
                  factura interna son documentos internos: no van a AFIP. */}
              {v.estado === "ACTIVA" && esComprobanteFiscal(v.tipo_comprobante) && !v.cae && (
                <Button
                  size="sm"
                  variant="ghost"
                  title="Emitir en AFIP"
                  onClick={() => emitir.mutate(v.id)}
                  disabled={emitir.isPending}
                >
                  {emitir.isPending && emitir.variables === v.id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <FileCheck2 className="h-3.5 w-3.5 text-primary" />}
                </Button>
              )}
              {v.estado === "ACTIVA" && v.tipo_comprobante !== "NOTA_CREDITO" && (
                <Button size="sm" variant="ghost" onClick={()=>setAnularDlg(v)}><Ban className="h-3.5 w-3.5 text-destructive"/></Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      <DetalleVenta venta={verVenta} onClose={()=>setVerVenta(null)}/>

      <Dialog open={!!anularDlg} onOpenChange={(v)=>!v && setAnularDlg(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Anular venta</DialogTitle></DialogHeader>
          <p className="text-sm">¿Confirmás anular <strong>{anularDlg?.numero_comprobante}</strong>? Se generará una nota de crédito y se devolverá el stock automáticamente.</p>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setAnularDlg(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={()=>anular.mutate(anularDlg.id)} disabled={anular.isPending}>Anular</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Estado fiscal del comprobante: si tiene CAE, si falló, o si ni siquiera aplica. */
function EstadoAfip({ venta }: { venta: any }) {
  if (!esComprobanteFiscal(venta.tipo_comprobante)) {
    return (
      <span title="Documento interno: no se declara a AFIP">
        <StatusPill tone="info">Interno</StatusPill>
      </span>
    );
  }
  if (venta.cae) {
    return (
      <div className="text-xs space-y-0.5">
        <StatusPill tone="success"><span className="font-mono">{venta.cae}</span></StatusPill>
        <div className="text-muted-foreground">
          {venta.afip_modo === "HOMOLOGACION" ? "homologación" : `PV ${venta.afip_punto_venta}-${venta.afip_numero}`}
        </div>
      </div>
    );
  }
  if (venta.afip_estado === "ERROR") {
    return (
      <span title={venta.afip_error ?? ""}>
        <StatusPill tone="danger" icon={<AlertTriangle className="h-2.5 w-2.5" />}>ERROR</StatusPill>
      </span>
    );
  }
  if (venta.afip_estado === "PENDIENTE") {
    return <StatusPill tone="warning">PENDIENTE</StatusPill>;
  }
  return <StatusPill tone="neutral">Sin emitir</StatusPill>;
}

const condIvaLabel: Record<string, string> = {
  RESPONSABLE_INSCRIPTO: "Responsable Inscripto",
  MONOTRIBUTO: "Monotributo",
};
// letra + código AFIP por CbteTipo (para el recuadro de la letra, estilo AFIP).
const CBTE_INFO: Record<number, { letra: string; cod: string }> = {
  1: { letra: "A", cod: "01" }, 2: { letra: "A", cod: "02" }, 3: { letra: "A", cod: "03" },
  6: { letra: "B", cod: "06" }, 7: { letra: "B", cod: "07" }, 8: { letra: "B", cod: "08" },
  11: { letra: "C", cod: "11" }, 12: { letra: "C", cod: "12" }, 13: { letra: "C", cod: "13" }, 15: { letra: "C", cod: "15" },
};
const tituloDeCbte = (c: number) =>
  [3, 8, 13].includes(c) ? "NOTA DE CRÉDITO" : [2, 7, 12].includes(c) ? "NOTA DE DÉBITO" : "FACTURA";
// cae_vencimiento viene 'YYYY-MM-DD': formateo manual para no correr un día por timezone.
const fmtVencCae = (s?: string | null) => (s ? s.split("-").reverse().join("/") : "—");

function DetalleVenta({ venta, onClose }: { venta: any; onClose: () => void }) {
  const { data: detail } = useQuery({
    queryKey: ["venta-detail", venta?.id],
    enabled: !!venta,
    queryFn: async () => {
      const [{ data: items = [] }, { data: pagos = [] }] = await Promise.all([
        supabase.from("venta_items").select("*").eq("venta_id", venta.id),
        supabase.from("venta_pagos").select("*").eq("venta_id", venta.id),
      ]);
      return { items: (items ?? []) as any[], pagos: (pagos ?? []) as any[] };
    },
  });
  const datosFiscalesFn = useServerFn(datosFiscalesComprobante);

  const imprimir = async () => {
    if (!venta) return;

    // Datos fiscales (CAE, QR, emisor real) sólo si el comprobante ya está autorizado.
    let fiscal: any = null;
    if (venta.cae && esComprobanteFiscal(venta.tipo_comprobante)) {
      try {
        fiscal = await datosFiscalesFn({ data: { venta_id: venta.id } });
      } catch {
        fiscal = null;
      }
    }

    const doc = new jsPDF();

    // Encabezado: razón social real de fiscal_config (ya no "CasaForma" hardcodeado).
    const emisorNombre = fiscal?.emisor?.razon_social ?? venta.sucursal?.nombre ?? "Comprobante";
    doc.setFontSize(16); doc.text(emisorNombre, 14, 16);
    doc.setFontSize(9);
    let hy = 22;
    if (fiscal?.emisor?.cuit) { doc.text(`CUIT: ${fiscal.emisor.cuit}`, 14, hy); hy += 5; }
    if (fiscal?.emisor?.condicion_iva) {
      doc.text(`Condición IVA: ${condIvaLabel[fiscal.emisor.condicion_iva] ?? fiscal.emisor.condicion_iva}`, 14, hy); hy += 5;
    }
    if (fiscal?.emisor?.domicilio_fiscal) { doc.text(String(fiscal.emisor.domicilio_fiscal), 14, hy); hy += 5; }

    // Título + número: fiscal (PPPPP-NNNNNNNN + letra/COD) si hay CAE; si no, el interno.
    const cbte = fiscal ? CBTE_INFO[fiscal.cbte_tipo] : null;
    const numeroMostrar = fiscal
      ? `${String(fiscal.punto_venta).padStart(5, "0")}-${String(fiscal.numero).padStart(8, "0")}`
      : venta.numero_comprobante;
    const titulo = cbte
      ? `${tituloDeCbte(fiscal.cbte_tipo)} ${cbte.letra} (COD. ${cbte.cod})`
      : tipoComprobanteLabel[venta.tipo_comprobante];

    doc.setFontSize(11); doc.text(`${titulo}   ${numeroMostrar}`, 14, hy + 2);
    doc.setFontSize(9);
    doc.text(`Fecha: ${fmtDateTime(venta.fecha)}`, 14, hy + 8);
    doc.text(`Cliente: ${venta.cliente?.razon_social ?? ""}${venta.cliente?.cuit_dni ? ` — ${venta.cliente.cuit_dni}` : ""}`, 14, hy + 14);

    autoTable(doc, {
      startY: hy + 20,
      head: [["Código", "Descripción", "Cant.", "Precio s/IVA", "Desc.", "IVA", "Subtotal"]],
      body: (detail?.items ?? []).map((i: any) => [
        i.codigo, i.descripcion, i.cantidad, fmtMoney(i.precio_unitario_sin_iva),
        `${i.descuento_porcentaje}%`, `${i.iva_porcentaje}%`, fmtMoney(i.subtotal_con_iva),
      ]),
      styles: { fontSize: 8 },
    });

    const y = (doc as any).lastAutoTable.finalY + 10;
    doc.setFontSize(9);
    doc.text(`Subtotal: ${fmtMoney(venta.subtotal_sin_iva)}`, 130, y);
    doc.text(`IVA: ${fmtMoney(venta.iva_total)}`, 130, y + 6);
    doc.text(`Percepciones: ${fmtMoney(venta.percepciones)}`, 130, y + 12);
    doc.setFontSize(12); doc.text(`TOTAL: ${fmtMoney(venta.total)}`, 130, y + 20);

    // Bloque CAE + QR de AFIP (sólo comprobantes autorizados que emitimos).
    if (fiscal?.cae && fiscal.qr) {
      const qy = y + 30;
      doc.addImage(fiscal.qr, "PNG", 14, qy, 32, 32);
      doc.setFontSize(9);
      doc.text("Comprobante Autorizado", 50, qy + 6);
      doc.text(`CAE N°: ${fiscal.cae}`, 50, qy + 12);
      doc.text(`Vto. CAE: ${fmtVencCae(fiscal.cae_vencimiento)}`, 50, qy + 18);
      if (fiscal.modo === "HOMOLOGACION") {
        doc.setFontSize(8);
        doc.text("Comprobante emitido en homologación — sin validez fiscal.", 50, qy + 24);
      }
    }

    doc.save(`${numeroMostrar}.pdf`);
  };

  return (
    <Dialog open={!!venta} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
        {venta && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center justify-between">
                <span>{tipoComprobanteLabel[venta.tipo_comprobante]} · {venta.numero_comprobante}</span>
                <Button size="sm" variant="outline" onClick={imprimir}><Printer className="h-4 w-4 mr-1"/> PDF</Button>
              </DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div><strong>Fecha:</strong> {fmtDateTime(venta.fecha)}</div>
              <div><strong>Sucursal:</strong> {venta.sucursal?.nombre}</div>
              <div><strong>Cliente:</strong> {venta.cliente?.razon_social}</div>
              <div><strong>CUIT/DNI:</strong> {venta.cliente?.cuit_dni ?? "—"}</div>
            </div>
            <div className="mt-2">
              <DataTable columns={["Cód.", "Descripción", "Cant.", "P. unit.", "Subtotal"]}>
                {(detail?.items ?? []).map((i:any,idx)=>(
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-xs">{i.codigo}</TableCell>
                    <TableCell>{i.descripcion}</TableCell>
                    <TableCell className="text-right">{i.cantidad}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(i.precio_unitario_sin_iva)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(i.subtotal_con_iva)}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
              <Card className="p-3">
                <h4 className="font-semibold text-sm mb-2">Pagos</h4>
                {venta.condicion_venta === "CTA_CTE" ? (
                  <p className="text-xs text-muted-foreground">
                    Venta a cuenta corriente. Los cobros de esta venta se registran y se ven en{" "}
                    <Link to="/cuentas-corrientes" className="text-primary underline">Cuentas Corrientes</Link>.
                  </p>
                ) : (detail?.pagos ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Sin pagos registrados.</p> :
                  <ul className="space-y-1 text-sm">
                    {detail!.pagos.map((p:any,i)=>(
                      <li key={i} className="flex justify-between">
                        <span>{formaPagoLabel[p.forma_pago]}{p.detalle && Object.keys(p.detalle).length ? ` (${Object.values(p.detalle).join(", ")})` : ""}</span>
                        <span className="font-mono">{fmtMoney(p.monto)}</span>
                      </li>
                    ))}
                  </ul>}
              </Card>
              <Card className="p-3">
                <h4 className="font-semibold text-sm mb-2">Totales</h4>
                <ul className="space-y-1 text-sm">
                  <li className="flex justify-between"><span>Subtotal:</span><span className="font-mono">{fmtMoney(venta.subtotal_sin_iva)}</span></li>
                  <li className="flex justify-between"><span>IVA:</span><span className="font-mono">{fmtMoney(venta.iva_total)}</span></li>
                  <li className="flex justify-between"><span>Percepciones:</span><span className="font-mono">{fmtMoney(venta.percepciones)}</span></li>
                  <li className="flex justify-between font-bold border-t border-border pt-1 mt-1"><span>TOTAL:</span><span className="font-mono">{fmtMoney(venta.total)}</span></li>
                  {venta.condicion_venta === "CTA_CTE" ? (
                    <li className="flex justify-between text-warning"><span>Condición:</span><span>A cuenta corriente</span></li>
                  ) : (
                    <>
                      <li className="flex justify-between text-success"><span>Pagado:</span><span className="font-mono">{fmtMoney(venta.total_pagado)}</span></li>
                      {Number(venta.total) - Number(venta.total_pagado) > 0.01 && (
                        <li className="flex justify-between text-destructive"><span>Pendiente:</span><span className="font-mono">{fmtMoney(Number(venta.total)-Number(venta.total_pagado))}</span></li>
                      )}
                    </>
                  )}
                </ul>
              </Card>
            </div>
            {venta.observaciones && <p className="text-xs text-muted-foreground mt-2"><strong>Obs:</strong> {venta.observaciones}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
