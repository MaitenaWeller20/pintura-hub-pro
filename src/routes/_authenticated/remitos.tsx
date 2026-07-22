import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Check, X, Printer, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearRemito, aprobarRemito, rechazarRemito } from "@/lib/stock.functions";
import { fmtDateTime } from "@/lib/format";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/remitos")({
  component: RemitosPage,
});

function RemitosPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [rechazar, setRechazar] = useState<any>(null);
  const aprobarFn = useServerFn(aprobarRemito);
  const rechazarFn = useServerFn(rechazarRemito);

  const { data: remitos = [] } = useQuery({
    queryKey: ["remitos"],
    queryFn: async () => ((await supabase.from("remitos").select(`
      *, origen:sucursales!sucursal_origen_id(nombre), destino:sucursales!sucursal_destino_id(nombre),
      items:remito_items(cantidad, producto:productos(codigo,nombre))
    `).order("created_at", { ascending: false })).data ?? []) as any[],
  });

  const aprobar = useMutation({
    mutationFn: async (id: string) => aprobarFn({ data: { remito_id: id } }),
    onSuccess: () => { toast.success("Remito aprobado y stock transferido"); qc.invalidateQueries({ queryKey: ["remitos"] }); },
    onError: (e:any) => toast.error(e.message),
  });
  const rech = useMutation({
    mutationFn: async (d: any) => rechazarFn({ data: d }),
    onSuccess: () => { toast.success("Remito rechazado"); qc.invalidateQueries({ queryKey: ["remitos"] }); setRechazar(null); },
    onError: (e:any) => toast.error(e.message),
  });

  const imprimir = (r:any) => {
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text(`CasaForma — Remito interno ${r.numero}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Origen: ${r.origen?.nombre}   Destino: ${r.destino?.nombre}`, 14, 24);
    doc.text(`Estado: ${r.estado}   Fecha: ${fmtDateTime(r.created_at)}`, 14, 30);
    autoTable(doc, {
      startY: 36,
      head: [["Código","Producto","Cantidad"]],
      body: (r.items ?? []).map((i:any) => [i.producto?.codigo, i.producto?.nombre, i.cantidad]),
      styles: { fontSize: 9 },
    });
    if (r.observaciones) { const y = (doc as any).lastAutoTable.finalY + 8; doc.text(`Obs: ${r.observaciones}`, 14, y); }
    doc.save(`${r.numero}.pdf`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Remitos internos</h1>
          <p className="text-sm text-muted-foreground">Transferencias entre sucursales</p>
        </div>
        <Button onClick={()=>setShowNew(true)}><Plus className="h-4 w-4 mr-1"/> Nuevo remito</Button>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Número</TableHead><TableHead>Origen → Destino</TableHead>
            <TableHead>Productos</TableHead><TableHead>Fecha</TableHead>
            <TableHead>Estado</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {remitos.map((r:any)=>(
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.numero}</TableCell>
                <TableCell className="text-sm">{r.origen?.nombre} <ArrowRight className="h-3 w-3 inline mx-1"/> {r.destino?.nombre}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.items?.length ?? 0} ítems</TableCell>
                <TableCell className="text-xs">{fmtDateTime(r.created_at)}</TableCell>
                <TableCell>
                  <Badge className={r.estado === "APROBADO" ? "bg-success text-success-foreground" : r.estado === "RECHAZADO" ? "bg-destructive text-destructive-foreground" : "bg-warning text-warning-foreground"}>
                    {r.estado}
                  </Badge>
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={()=>imprimir(r)}><Printer className="h-3.5 w-3.5"/></Button>
                  {/* R7: aprueba/rechaza sólo la sucursal DESTINO (o un admin). */}
                  {(cu?.isAdmin || cu?.sucursal?.id === r.sucursal_destino_id) && r.estado === "PENDIENTE" && (<>
                    <Button size="sm" variant="ghost" disabled={aprobar.isPending || rech.isPending} onClick={()=>aprobar.mutate(r.id)}><Check className="h-3.5 w-3.5 text-success"/></Button>
                    <Button size="sm" variant="ghost" disabled={aprobar.isPending || rech.isPending} onClick={()=>setRechazar(r)}><X className="h-3.5 w-3.5 text-destructive"/></Button>
                  </>)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <NuevoRemitoDialog open={showNew} onClose={()=>setShowNew(false)}
        onSaved={()=>{ qc.invalidateQueries({ queryKey:["remitos"] }); setShowNew(false); }}/>

      <Dialog open={!!rechazar} onOpenChange={(v)=>!v && setRechazar(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rechazar remito {rechazar?.numero}</DialogTitle></DialogHeader>
          <Label>Motivo *</Label><Textarea id="motivo_rechazo"/>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setRechazar(null)}>Cancelar</Button>
            <Button variant="destructive" onClick={()=>{
              const mot = (document.getElementById("motivo_rechazo") as HTMLTextAreaElement).value;
              if (!mot.trim()) return toast.error("Motivo requerido");
              rech.mutate({ remito_id: rechazar.id, motivo: mot });
            }}>Rechazar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NuevoRemitoDialog({ open, onClose, onSaved }: any) {
  const { data: cu } = useCurrentUser();
  const crear = useServerFn(crearRemito);
  const [origen, setOrigen] = useState<string>(cu?.sucursal?.id ?? "");
  const [destino, setDestino] = useState<string>("");
  const [obs, setObs] = useState("");
  const [items, setItems] = useState<Array<{ producto_id: string; codigo: string; nombre: string; cantidad: number }>>([]);
  const [pq, setPq] = useState("");
  const [showP, setShowP] = useState(false);

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });
  const { data: prods = [] } = useQuery({
    queryKey: ["prods-rem", pq],
    enabled: pq.length >= 2,
    queryFn: async () => ((await supabase.from("productos").select("id,codigo,nombre").or(`codigo.ilike.%${pq}%,nombre.ilike.%${pq}%`).limit(10)).data ?? []) as any[],
  });

  const m = useMutation({
    mutationFn: async () => crear({ data: {
      sucursal_origen_id: origen, sucursal_destino_id: destino, observaciones: obs,
      items: items.map(i => ({ producto_id: i.producto_id, cantidad: Number(i.cantidad) })),
    }}),
    onSuccess: (r:any) => { toast.success(`Remito ${r.numero} creado (pendiente de aprobación)`); onSaved(); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Nuevo remito de transferencia</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>Origen *</Label>
            <Select value={origen} onValueChange={setOrigen}>
              <SelectTrigger><SelectValue placeholder="—"/></SelectTrigger>
              <SelectContent>{sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
          <div><Label>Destino *</Label>
            <Select value={destino} onValueChange={setDestino}>
              <SelectTrigger><SelectValue placeholder="—"/></SelectTrigger>
              <SelectContent>{sucs.filter((s:any)=>s.id!==origen).map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <div className="flex justify-between mb-2"><Label>Productos *</Label>
            <Popover open={showP} onOpenChange={setShowP}>
              <PopoverTrigger asChild><Button size="sm" variant="outline"><Plus className="h-3 w-3 mr-1"/> Agregar</Button></PopoverTrigger>
              <PopoverContent className="w-[92vw] sm:w-[400px] p-2">
                <Input placeholder="Buscar…" value={pq} onChange={(e)=>setPq(e.target.value)} autoFocus/>
                <div className="max-h-60 overflow-auto mt-2">
                  {prods.map((p:any)=>(
                    <button key={p.id} className="w-full text-left p-2 hover:bg-accent rounded text-sm"
                      onClick={()=>{ setItems(i=>[...i, { producto_id: p.id, codigo: p.codigo, nombre: p.nombre, cantidad: 1 }]); setPq(""); setShowP(false); }}>
                      {p.codigo} — {p.nombre}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <Table>
            <TableHeader><TableRow><TableHead>Código</TableHead><TableHead>Producto</TableHead><TableHead>Cant.</TableHead><TableHead></TableHead></TableRow></TableHeader>
            <TableBody>
              {items.map((it,i)=>(
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{it.codigo}</TableCell>
                  <TableCell>{it.nombre}</TableCell>
                  <TableCell><NumberInput className="h-8 w-20" value={it.cantidad} onValueChange={(v)=>setItems(is=>is.map((x,idx)=>idx===i?{...x, cantidad: v ?? 0}:x))}/></TableCell>
                  <TableCell><Button size="sm" variant="ghost" onClick={()=>setItems(is=>is.filter((_,idx)=>idx!==i))}><Trash2 className="h-3.5 w-3.5 text-destructive"/></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div><Label>Observaciones</Label><Textarea value={obs} onChange={(e)=>setObs(e.target.value)} rows={2}/></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={()=>m.mutate()} disabled={!origen || !destino || origen===destino || items.length===0 || m.isPending}>Crear remito</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
