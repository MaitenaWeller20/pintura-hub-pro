import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { fmtMoney, fmtDateTime, formaPagoLabel } from "@/lib/format";
import { FileSpreadsheet, FileText } from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/reportes")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
    if (!roles?.some((r) => r.role === "admin")) throw redirect({ to: "/" });
  },
  component: ReportesPage,
});

function ReportesPage() {
  const [desde, setDesde] = useState(() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0,10); });
  const [hasta, setHasta] = useState(() => new Date().toISOString().slice(0,10));
  const [sucId, setSucId] = useState("");

  const { data: sucs = [] } = useQuery({ queryKey:["sucs"], queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[] });

  const { data: ventas = [] } = useQuery({
    queryKey: ["rep-ventas", desde, hasta, sucId],
    queryFn: async () => {
      let q = supabase.from("ventas").select(`
        *, cliente:clientes(razon_social), sucursal:sucursales(nombre),
        pagos:venta_pagos(forma_pago, monto)
      `).gte("fecha", desde+"T00:00:00").lte("fecha", hasta+"T23:59:59").eq("estado", "ACTIVA").order("fecha", { ascending:false });
      if (sucId) q = q.eq("sucursal_id", sucId);
      return (((await q).data) ?? []) as any[];
    },
  });

  const { data: ctaCte = [] } = useQuery({
    queryKey: ["rep-ctacte"],
    queryFn: async () => ((await supabase.from("ventas").select(`
      id, numero_comprobante, fecha, total, total_pagado, cliente:clientes(razon_social,cuit_dni), sucursal:sucursales(nombre)
    `).neq("estado_pago","PAGADO").eq("estado","ACTIVA").order("fecha", { ascending:false })).data ?? []) as any[],
  });

  const { data: movs = [] } = useQuery({
    queryKey: ["rep-movs", desde, hasta, sucId],
    queryFn: async () => {
      let q = supabase.from("stock_movimientos").select(`
        *, producto:productos(codigo,nombre), sucursal:sucursales(nombre)
      `).gte("created_at", desde+"T00:00:00").lte("created_at", hasta+"T23:59:59").order("created_at", { ascending:false }).limit(500);
      if (sucId) q = q.eq("sucursal_id", sucId);
      return (((await q).data) ?? []) as any[];
    },
  });

  const ventasResumen = useMemo(() => {
    const t: Record<string, number> = {}; let total = 0;
    ventas.forEach((v:any) => {
      total += Number(v.total);
      v.pagos.forEach((p:any) => { t[p.forma_pago] = (t[p.forma_pago] ?? 0) + Number(p.monto); });
    });
    return { total, porPago: t };
  }, [ventas]);

  const exportarVentas = (formato: "xlsx" | "pdf") => {
    const rows = ventas.map((v:any) => ({
      Comprobante: v.numero_comprobante, Fecha: v.fecha, Sucursal: v.sucursal?.nombre,
      Cliente: v.cliente?.razon_social, Subtotal: v.subtotal_sin_iva, IVA: v.iva_total, Total: v.total,
    }));
    if (formato === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ventas");
      XLSX.writeFile(wb, `ventas-${desde}-${hasta}.xlsx`);
    } else {
      const doc = new jsPDF();
      doc.setFontSize(14); doc.text(`CasaForma — Ventas ${desde} → ${hasta}`, 14, 16);
      autoTable(doc, {
        startY: 22,
        head: [["Comprob.","Fecha","Sucursal","Cliente","Subtotal","IVA","Total"]],
        body: ventas.map((v:any) => [
          v.numero_comprobante, fmtDateTime(v.fecha), v.sucursal?.nombre, v.cliente?.razon_social,
          fmtMoney(v.subtotal_sin_iva), fmtMoney(v.iva_total), fmtMoney(v.total),
        ]),
        styles: { fontSize: 7 },
      });
      doc.save(`ventas-${desde}-${hasta}.pdf`);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Reportes</h1>

      <Card className="p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <div><Label>Desde</Label><Input type="date" value={desde} onChange={(e)=>setDesde(e.target.value)}/></div>
        <div><Label>Hasta</Label><Input type="date" value={hasta} onChange={(e)=>setHasta(e.target.value)}/></div>
        <div><Label>Sucursal</Label>
          <Select value={sucId || "__all__"} onValueChange={(v)=>setSucId(v==="__all__"?"":v)}>
            <SelectTrigger><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas</SelectItem>
              {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Tabs defaultValue="ventas">
        <TabsList>
          <TabsTrigger value="ventas">Ventas</TabsTrigger>
          <TabsTrigger value="ctacte">Cuentas corrientes</TabsTrigger>
          <TabsTrigger value="stock">Movimientos stock</TabsTrigger>
        </TabsList>

        <TabsContent value="ventas" className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between mb-3 gap-2">
              <div>
                <div className="text-sm text-muted-foreground">Total facturado</div>
                <div className="text-3xl font-bold">{fmtMoney(ventasResumen.total)}</div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={()=>exportarVentas("xlsx")}><FileSpreadsheet className="h-4 w-4 mr-1"/> Excel</Button>
                <Button variant="outline" onClick={()=>exportarVentas("pdf")}><FileText className="h-4 w-4 mr-1"/> PDF</Button>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              {Object.entries(ventasResumen.porPago).map(([k,v])=>(
                <div key={k} className="border border-border rounded p-2">
                  <div className="text-xs text-muted-foreground">{formaPagoLabel[k]}</div>
                  <div className="font-mono font-semibold">{fmtMoney(v)}</div>
                </div>
              ))}
            </div>
          </Card>
          <Card className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Comprob.</TableHead><TableHead>Fecha</TableHead>
                <TableHead>Sucursal</TableHead><TableHead>Cliente</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {ventas.map((v:any)=>(
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                    <TableCell className="text-xs">{fmtDateTime(v.fecha)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>
                    <TableCell>{v.cliente?.razon_social}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="ctacte">
          <Card className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Comprob.</TableHead><TableHead>Cliente</TableHead>
                <TableHead>Sucursal</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Pagado</TableHead>
                <TableHead className="text-right">Pendiente</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {ctaCte.map((v:any)=>(
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-xs">{v.numero_comprobante}</TableCell>
                    <TableCell>{v.cliente?.razon_social}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{v.sucursal?.nombre}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(v.total)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtMoney(v.total_pagado)}</TableCell>
                    <TableCell className="text-right font-mono text-destructive">{fmtMoney(Number(v.total)-Number(v.total_pagado))}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        <TabsContent value="stock">
          <Card className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Fecha</TableHead><TableHead>Tipo</TableHead>
                <TableHead>Producto</TableHead><TableHead>Sucursal</TableHead>
                <TableHead className="text-right">Cantidad</TableHead>
                <TableHead>Motivo</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {movs.map((m:any)=>(
                  <TableRow key={m.id}>
                    <TableCell className="text-xs">{fmtDateTime(m.created_at)}</TableCell>
                    <TableCell className="text-xs">{m.tipo}</TableCell>
                    <TableCell className="text-xs">{m.producto?.codigo} — {m.producto?.nombre}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{m.sucursal?.nombre}</TableCell>
                    <TableCell className={`text-right font-mono ${Number(m.cantidad)>=0?"text-success":"text-destructive"}`}>{Number(m.cantidad)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{m.motivo}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
