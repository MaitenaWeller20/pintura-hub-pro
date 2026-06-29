import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { fmtMoney } from "@/lib/format";
import { toast } from "sonner";
import { Plus, Upload, Pencil, Printer } from "lucide-react";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/productos")({
  component: Productos,
});

function Productos() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const { data: productos = [] } = useQuery({
    queryKey: ["productos"],
    queryFn: async () => {
      const { data } = await supabase.from("productos")
        .select("*, categoria:categorias(id,nombre), marca:marcas(id,nombre)")
        .order("nombre");
      return (data ?? []) as any[];
    },
  });
  const { data: categorias = [] } = useQuery({
    queryKey: ["categorias"],
    queryFn: async () => ((await supabase.from("categorias").select("*").order("nombre")).data ?? []) as any[],
  });
  const { data: marcas = [] } = useQuery({
    queryKey: ["marcas"],
    queryFn: async () => ((await supabase.from("marcas").select("*").order("nombre")).data ?? []) as any[],
  });

  const filtered = useMemo(() => productos.filter((p:any) => {
    if (catFilter !== "all" && p.categoria_id !== catFilter) return false;
    if (q && !(`${p.codigo} ${p.nombre} ${p.marca?.nombre ?? ""}`).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  }), [productos, q, catFilter]);

  const exportar = () => {
    const ws = XLSX.utils.json_to_sheet(filtered.map((p:any) => ({
      Código: p.codigo, Nombre: p.nombre, Categoría: p.categoria?.nombre, Marca: p.marca?.nombre,
      Unidad: p.unidad_medida, "Precio s/IVA": p.precio_sin_iva, IVA: p.iva_porcentaje,
      "Stock mín.": p.stock_minimo, Activo: p.activo,
    })));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Productos");
    XLSX.writeFile(wb, "productos.xlsx");
  };
  const imprimir = () => {
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text("CasaForma — Listado de productos", 14, 16);
    autoTable(doc, {
      startY: 22,
      head: [["Código","Nombre","Marca","Unidad","Precio s/IVA","IVA","Stock mín."]],
      body: filtered.map((p:any) => [p.codigo, p.nombre, p.marca?.nombre ?? "", p.unidad_medida, fmtMoney(p.precio_sin_iva), `${p.iva_porcentaje}%`, p.stock_minimo]),
      styles: { fontSize: 8 },
    });
    doc.save("productos.pdf");
  };

  if (!cu) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Productos</h1>
          <p className="text-sm text-muted-foreground">{filtered.length} de {productos.length}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={imprimir}><Printer className="h-4 w-4 mr-1"/> PDF</Button>
          <Button variant="outline" onClick={exportar}><Upload className="h-4 w-4 mr-1"/> Excel</Button>
          {cu.isAdmin && (
            <>
              <Button variant="outline" asChild><Link to="/productos/importar">Importar</Link></Button>
              <Button onClick={() => { setEditing(null); setOpen(true); }}>
                <Plus className="h-4 w-4 mr-1"/> Nuevo
              </Button>
            </>
          )}
        </div>
      </div>

      <Card className="p-3 flex flex-wrap gap-2 items-center">
        <Input placeholder="Buscar por código, nombre o marca…" value={q} onChange={(e)=>setQ(e.target.value)}
               className="max-w-xs"/>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-52"><SelectValue/></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas las categorías</SelectItem>
            {categorias.map((c:any)=>(<SelectItem key={c.id} value={c.id}>{c.nombre}</SelectItem>))}
          </SelectContent>
        </Select>
      </Card>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Código</TableHead><TableHead>Nombre</TableHead>
              <TableHead>Categoría</TableHead><TableHead>Marca</TableHead>
              <TableHead className="text-right">Precio s/IVA</TableHead>
              <TableHead>IVA</TableHead><TableHead className="text-right">Stock mín.</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((p:any) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-xs">{p.codigo}</TableCell>
                <TableCell>{p.nombre} {!p.activo && <Badge variant="outline" className="ml-2 text-xs">Inactivo</Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{p.categoria?.nombre}</TableCell>
                <TableCell className="text-muted-foreground">{p.marca?.nombre}</TableCell>
                <TableCell className="text-right font-mono">{fmtMoney(p.precio_sin_iva)}</TableCell>
                <TableCell>{p.iva_porcentaje}%</TableCell>
                <TableCell className="text-right font-mono">{p.stock_minimo}</TableCell>
                <TableCell>
                  {cu.isAdmin && (
                    <Button size="sm" variant="ghost" onClick={()=>{ setEditing(p); setOpen(true); }}>
                      <Pencil className="h-3.5 w-3.5"/>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <ProductoDialog open={open} onClose={()=>setOpen(false)} editing={editing}
        categorias={categorias} marcas={marcas}
        onSaved={()=>{ qc.invalidateQueries({ queryKey:["productos"] }); setOpen(false); }} />
    </div>
  );
}

function ProductoDialog({ open, onClose, editing, categorias, marcas, onSaved }: any) {
  const [form, setForm] = useState<any>(editing ?? {
    codigo: "", nombre: "", categoria_id: null, marca_id: null,
    unidad_medida: "unidad", precio_sin_iva: 0, iva_porcentaje: 21, stock_minimo: 0, activo: true,
  });
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const m = useMutation({
    mutationFn: async () => {
      const payload = {
        codigo: form.codigo, nombre: form.nombre,
        categoria_id: form.categoria_id, marca_id: form.marca_id,
        unidad_medida: form.unidad_medida,
        precio_sin_iva: Number(form.precio_sin_iva),
        iva_porcentaje: Number(form.iva_porcentaje),
        stock_minimo: Number(form.stock_minimo), activo: form.activo,
      };
      if (editing) {
        const { error } = await supabase.from("productos").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("productos").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast.success("Producto guardado"); onSaved(); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{editing ? "Editar" : "Nuevo"} producto</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Código *</Label><Input value={form.codigo} onChange={(e)=>set("codigo", e.target.value)}/></div>
          <div><Label>Unidad</Label><Input value={form.unidad_medida} onChange={(e)=>set("unidad_medida", e.target.value)}/></div>
          <div className="col-span-2"><Label>Nombre *</Label><Input value={form.nombre} onChange={(e)=>set("nombre", e.target.value)}/></div>
          <div>
            <Label>Categoría</Label>
            <Select value={form.categoria_id ?? ""} onValueChange={(v)=>set("categoria_id", v||null)}>
              <SelectTrigger><SelectValue placeholder="—"/></SelectTrigger>
              <SelectContent>{categorias.map((c:any)=>(<SelectItem key={c.id} value={c.id}>{c.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Marca</Label>
            <Select value={form.marca_id ?? ""} onValueChange={(v)=>set("marca_id", v||null)}>
              <SelectTrigger><SelectValue placeholder="—"/></SelectTrigger>
              <SelectContent>{marcas.map((m:any)=>(<SelectItem key={m.id} value={m.id}>{m.nombre}</SelectItem>))}</SelectContent>
            </Select>
          </div>
          <div><Label>Precio s/IVA</Label><Input type="number" step="0.01" value={form.precio_sin_iva} onChange={(e)=>set("precio_sin_iva", e.target.value)}/></div>
          <div><Label>IVA %</Label>
            <Select value={String(form.iva_porcentaje)} onValueChange={(v)=>set("iva_porcentaje", Number(v))}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="21">21%</SelectItem><SelectItem value="10.5">10,5%</SelectItem><SelectItem value="0">Exento</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Stock mínimo</Label><Input type="number" step="0.01" value={form.stock_minimo} onChange={(e)=>set("stock_minimo", e.target.value)}/></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={()=>m.mutate()} disabled={m.isPending}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
