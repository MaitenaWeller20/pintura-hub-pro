import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { fmtMoney, fmtDateTime, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { Plus, Eye, Ban, Printer, FileSpreadsheet, FileCheck2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { anularVenta } from "@/lib/ventas.functions";
import { emitirComprobante } from "@/lib/fiscal.functions";
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

  const { data: ventas = [] } = useQuery({
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Ventas</h1>
          <p className="text-sm text-muted-foreground">{filtered.length} comprobantes</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={exportar}><FileSpreadsheet className="h-4 w-4 mr-1"/> Excel</Button>
          <Button asChild><Link to="/ventas/nueva"><Plus className="h-4 w-4 mr-1"/> Nueva venta</Link></Button>
        </div>
      </div>

      <Card className="p-3 flex flex-wrap gap-2">
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
      </Card>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead><TableHead>Tipo</TableHead>
              <TableHead>Fecha</TableHead><TableHead>Cliente</TableHead>
              {cu?.isAdmin && <TableHead>Sucursal</TableHead>}
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>AFIP</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((v:any) => (
              <TableRow key={v.id} className={v.estado === "ANULADA" ? "opacity-50" : ""}>
                <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                <TableCell>{tipoComprobanteLabel[v.tipo_comprobante]}</TableCell>
                <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
                <TableCell>{v.cliente?.razon_social}</TableCell>
                {cu?.isAdmin && <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>}
                <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
                <TableCell>
                  {v.estado === "ANULADA" ? <Badge variant="outline">ANULADA</Badge> : (
                    <Badge className={v.estado_pago === "PAGADO" ? "bg-success text-success-foreground" : v.estado_pago === "PARCIAL" ? "bg-warning text-warning-foreground" : "bg-destructive text-destructive-foreground"}>
                      {v.estado_pago}
                    </Badge>
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
          </TableBody>
        </Table>
      </Card>

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
    return <span className="text-xs text-muted-foreground" title="Documento interno: no se declara a AFIP">Interno</span>;
  }
  if (venta.cae) {
    return (
      <div className="text-xs">
        <div className="font-mono">{venta.cae}</div>
        <div className="text-muted-foreground">
          {venta.afip_modo === "HOMOLOGACION" ? "homologación" : `PV ${venta.afip_punto_venta}-${venta.afip_numero}`}
        </div>
      </div>
    );
  }
  if (venta.afip_estado === "ERROR") {
    return (
      <Badge variant="outline" className="border-destructive text-destructive gap-1 text-[10px]" title={venta.afip_error ?? ""}>
        <AlertTriangle className="h-2.5 w-2.5" /> ERROR
      </Badge>
    );
  }
  if (venta.afip_estado === "PENDIENTE") {
    return <Badge variant="outline" className="border-warning text-warning text-[10px]">PENDIENTE</Badge>;
  }
  return <span className="text-xs text-muted-foreground">Sin emitir</span>;
}

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

  const imprimir = () => {
    if (!venta) return;
    const doc = new jsPDF();
    doc.setFontSize(16); doc.text("CasaForma", 14, 16);
    doc.setFontSize(10); doc.text(`${tipoComprobanteLabel[venta.tipo_comprobante]} ${venta.numero_comprobante}`, 14, 22);
    doc.text(`Fecha: ${fmtDateTime(venta.fecha)}`, 14, 28);
    doc.text(`Sucursal: ${venta.sucursal?.nombre ?? ""}`, 14, 34);
    doc.text(`Cliente: ${venta.cliente?.razon_social ?? ""}${venta.cliente?.cuit_dni ? ` — ${venta.cliente.cuit_dni}` : ""}`, 14, 40);
    autoTable(doc, {
      startY: 46,
      head: [["Código","Descripción","Cant.","Precio s/IVA","Desc.","IVA","Subtotal"]],
      body: (detail?.items ?? []).map((i:any) => [
        i.codigo, i.descripcion, i.cantidad, fmtMoney(i.precio_unitario_sin_iva),
        `${i.descuento_porcentaje}%`, `${i.iva_porcentaje}%`, fmtMoney(i.subtotal_con_iva),
      ]),
      styles: { fontSize: 8 },
    });
    const y = (doc as any).lastAutoTable.finalY + 10;
    doc.text(`Subtotal: ${fmtMoney(venta.subtotal_sin_iva)}`, 130, y);
    doc.text(`IVA: ${fmtMoney(venta.iva_total)}`, 130, y+6);
    doc.text(`Percepciones: ${fmtMoney(venta.percepciones)}`, 130, y+12);
    doc.setFontSize(12); doc.text(`TOTAL: ${fmtMoney(venta.total)}`, 130, y+20);
    doc.save(`${venta.numero_comprobante}.pdf`);
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
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><strong>Fecha:</strong> {fmtDateTime(venta.fecha)}</div>
              <div><strong>Sucursal:</strong> {venta.sucursal?.nombre}</div>
              <div><strong>Cliente:</strong> {venta.cliente?.razon_social}</div>
              <div><strong>CUIT/DNI:</strong> {venta.cliente?.cuit_dni ?? "—"}</div>
            </div>
            <Card className="overflow-x-auto mt-2">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Cód.</TableHead><TableHead>Descripción</TableHead>
                  <TableHead className="text-right">Cant.</TableHead><TableHead className="text-right">P. unit.</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {(detail?.items ?? []).map((i:any,idx)=>(
                    <TableRow key={idx}>
                      <TableCell className="font-mono text-xs">{i.codigo}</TableCell>
                      <TableCell>{i.descripcion}</TableCell>
                      <TableCell className="text-right">{i.cantidad}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(i.precio_unitario_sin_iva)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMoney(i.subtotal_con_iva)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            <div className="grid grid-cols-2 gap-4 mt-3">
              <Card className="p-3">
                <h4 className="font-semibold text-sm mb-2">Pagos</h4>
                {(detail?.pagos ?? []).length === 0 ? <p className="text-xs text-muted-foreground">Sin pagos registrados.</p> :
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
                  <li className="flex justify-between text-success"><span>Pagado:</span><span className="font-mono">{fmtMoney(venta.total_pagado)}</span></li>
                  {Number(venta.total) - Number(venta.total_pagado) > 0 && (
                    <li className="flex justify-between text-destructive"><span>Pendiente:</span><span className="font-mono">{fmtMoney(Number(venta.total)-Number(venta.total_pagado))}</span></li>
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
