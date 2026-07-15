import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { tipoClienteLabel } from "@/lib/format";
import { validarCuitDni } from "@/lib/fiscal/codigos";

export const Route = createFileRoute("/_authenticated/proveedores")({
  component: ProveedoresPage,
});

function ProveedoresPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);

  const { data: proveedores = [], isLoading } = useQuery({
    queryKey: ["proveedores"],
    queryFn: async () => ((await supabase.from("proveedores").select("*").order("razon_social")).data ?? []) as any[],
  });

  const filtered = useMemo(() => proveedores.filter((p: any) =>
    !q || `${p.razon_social} ${p.cuit_dni ?? ""}`.toLowerCase().includes(q.toLowerCase())
  ), [proveedores, q]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proveedores"
        subtitle={`${filtered.length} de ${proveedores.length}`}
        actions={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4 mr-1" /> Nuevo</Button>}
      />

      <SectionCard>
        <Input placeholder="Buscar por nombre o CUIT…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      </SectionCard>

      <DataTable
        columns={["Razón social", "CUIT", "Condición IVA", "Cta Cte", "Teléfono", ""]}
        loading={isLoading}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay proveedores para mostrar." }}
      >
        {filtered.map((p: any) => (
          <TableRow key={p.id}>
            <TableCell>
              {p.razon_social}
              {!p.activo && <span className="ml-2 align-middle"><StatusPill tone="neutral">Inactivo</StatusPill></span>}
            </TableCell>
            <TableCell className="font-mono text-xs">{p.cuit_dni ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{tipoClienteLabel[p.condicion_iva]}</TableCell>
            <TableCell>{p.condicion_cta_cte ? <StatusPill tone="success">Sí</StatusPill> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
            <TableCell>{p.telefono ?? "—"}</TableCell>
            <TableCell>
              <div className="flex gap-1 justify-end">
                <Button size="sm" variant="ghost" onClick={() => { setEditing(p); setOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {/* key: remonta el diálogo al abrir/cambiar de proveedor para inicializar el form. */}
      <ProveedorDialog key={`${editing?.id ?? "nuevo"}-${open}`} open={open} onClose={() => setOpen(false)} editing={editing}
        onSaved={() => { qc.invalidateQueries({ queryKey: ["proveedores"] }); setOpen(false); }} />
    </div>
  );
}

function ProveedorDialog({ open, onClose, editing, onSaved }: any) {
  const [form, setForm] = useState<any>(editing ?? {
    razon_social: "", cuit_dni: "", condicion_iva: "RESPONSABLE_INSCRIPTO",
    telefono: "", email: "", direccion: "", condicion_cta_cte: false, activo: true,
  });
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const cuitError = validarCuitDni(form.cuit_dni);
  const m = useMutation({
    mutationFn: async () => {
      const errCuit = validarCuitDni(form.cuit_dni);
      if (errCuit) throw new Error(errCuit);
      const cuitNorm = (form.cuit_dni ?? "").replace(/\D/g, "");
      const payload = { ...form, cuit_dni: cuitNorm || null };
      delete payload.created_at; delete payload.updated_at;
      if (editing) {
        const { error } = await supabase.from("proveedores").update(payload).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("proveedores").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { toast.success("Proveedor guardado"); onSaved(); },
    onError: (e: any) => toast.error(
      e?.code === "23505" || /duplicate key|uq_proveedores_cuit/.test(e?.message ?? "")
        ? "Ya existe un proveedor con ese CUIT."
        : e.message,
    ),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{editing ? "Editar" : "Nuevo"} proveedor</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Razón social / Nombre *</Label><Input value={form.razon_social} onChange={(e) => set("razon_social", e.target.value)} /></div>
          <div>
            <Label>CUIT</Label>
            <Input value={form.cuit_dni ?? ""} onChange={(e) => set("cuit_dni", e.target.value)}
              className={cuitError ? "border-destructive" : undefined} />
            {cuitError && <p className="text-xs text-destructive mt-1">{cuitError}</p>}
          </div>
          <div>
            <Label>Condición IVA</Label>
            <Select value={form.condicion_iva} onValueChange={(v) => set("condicion_iva", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</SelectItem>
                <SelectItem value="MONOTRIBUTISTA">Monotributista</SelectItem>
                <SelectItem value="EXENTO">Exento</SelectItem>
                <SelectItem value="CONSUMIDOR_FINAL">Consumidor Final</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Teléfono</Label><Input value={form.telefono ?? ""} onChange={(e) => set("telefono", e.target.value)} /></div>
          <div><Label>Email</Label><Input value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></div>
          <div className="col-span-2"><Label>Dirección</Label><Input value={form.direccion ?? ""} onChange={(e) => set("direccion", e.target.value)} /></div>
          <label className="col-span-2 flex items-center gap-2 text-sm border border-border rounded p-2 bg-muted/30">
            <input type="checkbox" checked={!!form.condicion_cta_cte} onChange={(e) => set("condicion_cta_cte", e.target.checked)} />
            <span><strong>Proveedor con Cuenta Corriente</strong> — se le puede comprar a crédito y llevar la deuda. Gestionar en Cuentas corrientes → Proveedores.</span>
          </label>
          {editing && (
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!form.activo} onChange={(e) => set("activo", e.target.checked)} />
              <span>Activo</span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !form.razon_social.trim() || !!cuitError}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
