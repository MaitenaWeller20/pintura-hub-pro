import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { toast } from "sonner";
import { Plus, Pencil, Receipt } from "lucide-react";
import { tipoClienteLabel } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/clientes")({
  component: ClientesPage,
});

function ClientesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const { data: clientes = [], isLoading } = useQuery({
    queryKey: ["clientes"],
    queryFn: async () => ((await supabase.from("clientes").select("*, sucursal:sucursales(nombre)").order("razon_social")).data ?? []) as any[],
  });
  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  const filtered = useMemo(() => clientes.filter((c:any) =>
    !q || `${c.razon_social} ${c.cuit_dni ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [clientes, q]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clientes"
        subtitle={`${filtered.length} de ${clientes.length}`}
        actions={
          <Button onClick={()=>{ setEditing(null); setOpen(true); }}><Plus className="h-4 w-4 mr-1"/> Nuevo</Button>
        }
      />

      <SectionCard>
        <Input placeholder="Buscar por nombre o CUIT…" value={q} onChange={(e)=>setQ(e.target.value)} className="max-w-sm"/>
      </SectionCard>

      <DataTable
        columns={["Razón social", "CUIT/DNI", "Tipo", "Cta Cte", "Teléfono", "Sucursal", ""]}
        loading={isLoading}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay clientes para mostrar." }}
      >
        {filtered.map((c:any) => (
          <TableRow key={c.id}>
            <TableCell>
              {c.razon_social}
              {c.es_generico && <span className="ml-2 align-middle"><StatusPill tone="neutral">Genérico</StatusPill></span>}
            </TableCell>
            <TableCell className="font-mono text-xs">{c.cuit_dni ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{tipoClienteLabel[c.tipo]}</TableCell>
            <TableCell>{c.condicion_cta_cte ? <StatusPill tone="success">Sí</StatusPill> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
            <TableCell>{c.telefono ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{c.sucursal?.nombre ?? "—"}</TableCell>
            <TableCell>
              <div className="flex gap-1 justify-end">
                {c.condicion_cta_cte && (
                  <Button size="sm" variant="ghost" asChild title="Ver cuenta corriente">
                    <Link to="/cuentas-corrientes" search={{ cliente: c.id }}><Receipt className="h-3.5 w-3.5"/></Link>
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={()=>{ setEditing(c); setOpen(true); }}><Pencil className="h-3.5 w-3.5"/></Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {/* key: fuerza remontar el diálogo al abrirlo o al cambiar de cliente, para que
          el form se inicialice con los datos del cliente. Sin esto, useState(editing…)
          se evaluaba una sola vez (con editing=null) y editar guardaba campos vacíos. */}
      <ClienteDialog key={`${editing?.id ?? "nuevo"}-${open}`} open={open} onClose={()=>setOpen(false)} editing={editing} sucs={sucs}
        onSaved={()=>{ qc.invalidateQueries({ queryKey:["clientes"] }); setOpen(false); }}/>
    </div>
  );
}

function ClienteDialog({ open, onClose, editing, sucs, onSaved }: any) {
  const [form, setForm] = useState<any>(editing ?? {
    razon_social: "", cuit_dni: "", tipo: "CONSUMIDOR_FINAL",
    telefono: "", email: "", direccion: "", sucursal_habitual_id: null,
    condicion_cta_cte: false,
  });
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const m = useMutation({
    mutationFn: async () => {
      const payload = { ...form, sucursal_habitual_id: form.sucursal_habitual_id || null };
      delete payload.sucursal; delete payload.created_at; delete payload.updated_at; delete payload.es_generico; delete payload.activo;
      if (editing) {
        const { error } = await supabase.from("clientes").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("clientes").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast.success("Cliente guardado"); onSaved(); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{editing ? "Editar" : "Nuevo"} cliente</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Razón social / Nombre *</Label><Input value={form.razon_social} onChange={(e)=>set("razon_social", e.target.value)}/></div>
          <div><Label>CUIT / DNI</Label><Input value={form.cuit_dni ?? ""} onChange={(e)=>set("cuit_dni", e.target.value)}/></div>
          <div>
            <Label>Tipo impositivo</Label>
            <Select value={form.tipo} onValueChange={(v)=>set("tipo", v)}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="CONSUMIDOR_FINAL">Consumidor Final</SelectItem>
                <SelectItem value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</SelectItem>
                <SelectItem value="MONOTRIBUTISTA">Monotributista</SelectItem>
                <SelectItem value="EXENTO">Exento</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Teléfono</Label><Input value={form.telefono ?? ""} onChange={(e)=>set("telefono", e.target.value)}/></div>
          <div><Label>Email</Label><Input value={form.email ?? ""} onChange={(e)=>set("email", e.target.value)}/></div>
          <div className="col-span-2"><Label>Dirección</Label><Input value={form.direccion ?? ""} onChange={(e)=>set("direccion", e.target.value)}/></div>
          <div className="col-span-2">
            <Label>Sucursal habitual</Label>
            <Select value={form.sucursal_habitual_id ?? "__none__"} onValueChange={(v)=>set("sucursal_habitual_id", v==="__none__"?null:v)}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <label className="col-span-2 flex items-center gap-2 text-sm border border-border rounded p-2 bg-muted/30">
            <input type="checkbox" checked={!!form.condicion_cta_cte} onChange={(e)=>set("condicion_cta_cte", e.target.checked)} />
            <span><strong>Cliente con Cuenta Corriente</strong> — puede llevar mercadería sin pagar en el momento. Gestionar deuda en la pestaña Cta Cte.</span>
          </label>
          {form.condicion_cta_cte && (
            <div className="col-span-2">
              <Label>Límite de crédito (opcional)</Label>
              <NumberInput value={form.limite_credito ?? null} onValueChange={(v)=>set("limite_credito", v)} className="max-w-xs" />
              <p className="text-[11px] text-muted-foreground mt-1">Deuda máxima que se le permite acumular. Vacío = sin límite.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={()=>m.mutate()} disabled={m.isPending || !form.razon_social.trim()}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
