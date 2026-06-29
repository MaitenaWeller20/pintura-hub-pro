import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { fmtNum } from "@/lib/format";
import { useServerFn } from "@tanstack/react-start";
import { ajusteStock } from "@/lib/stock.functions";
import { toast } from "sonner";
import { Pencil, Printer } from "lucide-react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/stock")({
  component: Stock,
});

function Stock() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [sucFilter, setSucFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [bajoSolo, setBajoSolo] = useState(false);
  const [ajuste, setAjuste] = useState<any>(null);
  const ajusteFn = useServerFn(ajusteStock);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const sucId = sucFilter || (cu?.isAdmin ? "" : cu?.sucursal?.id ?? "");

  const { data: stock = [] } = useQuery({
    queryKey: ["stock", sucId],
    enabled: !!cu,
    queryFn: async () => {
      let q = supabase.from("stock_sucursal").select(`
        cantidad, sucursal_id,
        sucursal:sucursales(nombre,codigo),
        producto:productos!inner(id,codigo,nombre,stock_minimo,unidad_medida,categoria:categorias(nombre),marca:marcas(nombre))
      `);
      if (sucId) q = q.eq("sucursal_id", sucId);
      const { data } = await q;
      return (data ?? []) as any[];
    },
  });

  const filtered = useMemo(() => stock.filter((s:any) => {
    if (bajoSolo && Number(s.cantidad) > Number(s.producto.stock_minimo)) return false;
    if (q && !`${s.producto.codigo} ${s.producto.nombre}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [stock, q, bajoSolo]);

  const m = useMutation({
    mutationFn: async (data: any) => ajusteFn({ data }),
    onSuccess: () => { toast.success("Stock ajustado"); qc.invalidateQueries({ queryKey:["stock"] }); setAjuste(null); },
    onError: (e:any) => toast.error(e.message),
  });

  const imprimir = () => {
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text(`CasaForma — Stock ${sucId ? sucs.find((s:any)=>s.id===sucId)?.nombre : "Global"}`, 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [["Código","Producto","Sucursal","Cantidad","Mín.","Estado"]],
      body: filtered.map((s:any) => [
        s.producto.codigo, s.producto.nombre, s.sucursal?.nombre ?? "",
        fmtNum(s.cantidad), s.producto.stock_minimo,
        Number(s.cantidad) <= 0 ? "Sin stock" : Number(s.cantidad) <= Number(s.producto.stock_minimo) ? "Bajo" : "OK",
      ]),
      styles: { fontSize: 8 },
    });
    doc.save("stock.pdf");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Inventario</h1>
          <p className="text-sm text-muted-foreground">{filtered.length} ítems</p>
        </div>
        <Button variant="outline" onClick={imprimir}><Printer className="h-4 w-4 mr-1"/> Imprimir PDF</Button>
      </div>

      <Card className="p-3 flex flex-wrap gap-2 items-center">
        <Input placeholder="Buscar producto…" value={q} onChange={(e)=>setQ(e.target.value)} className="max-w-xs"/>
        {cu?.isAdmin && (
          <Select value={sucFilter || "__all__"} onValueChange={(v)=>setSucFilter(v==="__all__"?"":v)}>
            <SelectTrigger className="w-48"><SelectValue/></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas las sucursales</SelectItem>
              {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
            </SelectContent>
          </Select>
        )}
        <label className="flex items-center gap-2 text-sm ml-2">
          <input type="checkbox" checked={bajoSolo} onChange={(e)=>setBajoSolo(e.target.checked)}/> Solo stock bajo
        </label>
      </Card>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead><TableHead>Producto</TableHead>
              <TableHead>Sucursal</TableHead>
              <TableHead className="text-right">Cantidad</TableHead>
              <TableHead className="text-right">Mínimo</TableHead>
              <TableHead>Estado</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((s:any) => {
              const cant = Number(s.cantidad), min = Number(s.producto.stock_minimo);
              const estado = cant <= 0 ? "destructive" : cant <= min ? "warning" : "success";
              const txt = cant <= 0 ? "Sin stock" : cant <= min ? "Bajo" : "OK";
              return (
                <TableRow key={`${s.producto.id}-${s.sucursal_id}`}>
                  <TableCell className="font-mono text-xs">{s.producto.codigo}</TableCell>
                  <TableCell>{s.producto.nombre}</TableCell>
                  <TableCell className="text-muted-foreground">{s.sucursal?.nombre}</TableCell>
                  <TableCell className="text-right font-mono">{fmtNum(cant)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{fmtNum(min)}</TableCell>
                  <TableCell>
                    <Badge className={estado === "success" ? "bg-success text-success-foreground" : estado === "warning" ? "bg-warning text-warning-foreground" : "bg-destructive text-destructive-foreground"}>
                      {txt}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {cu?.isAdmin && (
                      <Button size="sm" variant="ghost" onClick={()=>setAjuste({
                        producto_id: s.producto.id, sucursal_id: s.sucursal_id,
                        producto_nombre: s.producto.nombre, sucursal_nombre: s.sucursal?.nombre,
                        cantidad_actual: cant,
                      })}><Pencil className="h-3.5 w-3.5"/></Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={!!ajuste} onOpenChange={(v)=>!v && setAjuste(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Ajuste de stock</DialogTitle></DialogHeader>
          {ajuste && (
            <div className="space-y-3">
              <div className="text-sm">
                <div><strong>Producto:</strong> {ajuste.producto_nombre}</div>
                <div><strong>Sucursal:</strong> {ajuste.sucursal_nombre}</div>
                <div><strong>Cantidad actual:</strong> {ajuste.cantidad_actual}</div>
              </div>
              <div>
                <Label>Nueva cantidad</Label>
                <Input type="number" step="0.01" defaultValue={ajuste.cantidad_actual} id="nueva_cant"/>
              </div>
              <div>
                <Label>Motivo *</Label>
                <Textarea id="motivo" placeholder="Conteo físico, rotura, devolución, etc."/>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={()=>setAjuste(null)}>Cancelar</Button>
                <Button onClick={()=>{
                  const cant = Number((document.getElementById("nueva_cant") as HTMLInputElement).value);
                  const mot = (document.getElementById("motivo") as HTMLTextAreaElement).value;
                  if (!mot.trim()) { toast.error("Motivo requerido"); return; }
                  m.mutate({ producto_id: ajuste.producto_id, sucursal_id: ajuste.sucursal_id, nueva_cantidad: cant, motivo: mot });
                }}>Guardar</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
