import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Power } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearUsuario, toggleUsuarioActivo } from "@/lib/usuarios.functions";

export const Route = createFileRoute("/_authenticated/usuarios")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
    if (!roles?.some((r) => r.role === "admin")) throw redirect({ to: "/" });
  },
  component: UsuariosPage,
});

function UsuariosPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const crear = useServerFn(crearUsuario);
  const toggle = useServerFn(toggleUsuarioActivo);

  const { data: usuarios = [] } = useQuery({
    queryKey: ["usuarios"],
    queryFn: async () => {
      const { data: profiles = [] } = await supabase.from("profiles")
        .select("*, sucursal:sucursales(nombre)").order("username");
      const ids = (profiles ?? []).map((p:any) => p.id);
      if (ids.length === 0) return [];
      const { data: roles = [] } = await supabase.from("user_roles").select("*").in("user_id", ids);
      return (profiles ?? []).map((p:any) => ({
        ...p, role: (roles ?? []).find((r:any) => r.user_id === p.id)?.role ?? null,
      }));
    },
  });

  const { data: sucs = [] } = useQuery({ queryKey:["sucs"], queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[] });

  const togg = useMutation({
    mutationFn: async (d: any) => toggle({ data: d }),
    onSuccess: () => { toast.success("Estado actualizado"); qc.invalidateQueries({ queryKey:["usuarios"] }); },
    onError: (e:any) => toast.error(e.message),
  });

  const [form, setForm] = useState<any>({ email:"", password:"emp1234", username:"", nombre_completo:"", role:"empleado", sucursal_id: null });
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const m = useMutation({
    mutationFn: async () => crear({ data: form }),
    onSuccess: () => { toast.success("Usuario creado"); qc.invalidateQueries({ queryKey:["usuarios"] }); setOpen(false);
      setForm({ email:"", password:"emp1234", username:"", nombre_completo:"", role:"empleado", sucursal_id: null }); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Usuarios</h1>
        <Button onClick={()=>setOpen(true)}><Plus className="h-4 w-4 mr-1"/> Nuevo</Button>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Usuario</TableHead><TableHead>Nombre</TableHead>
            <TableHead>Rol</TableHead><TableHead>Sucursal</TableHead>
            <TableHead>Estado</TableHead><TableHead></TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {usuarios.map((u:any)=>(
              <TableRow key={u.id}>
                <TableCell className="font-mono text-xs">{u.username}</TableCell>
                <TableCell>{u.nombre_completo ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role ?? "—"}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">{u.sucursal?.nombre ?? "—"}</TableCell>
                <TableCell>{u.activo ? <Badge className="bg-success text-success-foreground">Activo</Badge> : <Badge variant="outline">Inactivo</Badge>}</TableCell>
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={()=>togg.mutate({ user_id: u.id, activo: !u.activo })}>
                    <Power className="h-3.5 w-3.5"/>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nuevo usuario</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Email *</Label><Input type="email" value={form.email} onChange={(e)=>set("email", e.target.value)}/></div>
            <div><Label>Contraseña *</Label><Input value={form.password} onChange={(e)=>set("password", e.target.value)}/></div>
            <div><Label>Usuario (alias) *</Label><Input value={form.username} onChange={(e)=>set("username", e.target.value)}/></div>
            <div><Label>Nombre completo</Label><Input value={form.nombre_completo} onChange={(e)=>set("nombre_completo", e.target.value)}/></div>
            <div><Label>Rol *</Label>
              <Select value={form.role} onValueChange={(v)=>set("role", v)}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent><SelectItem value="empleado">Empleado</SelectItem><SelectItem value="admin">Administrador</SelectItem></SelectContent>
              </Select>
            </div>
            <div><Label>Sucursal {form.role==="empleado"?"*":"(opcional)"}</Label>
              <Select value={form.sucursal_id ?? "__none__"} onValueChange={(v)=>set("sucursal_id", v==="__none__"?null:v)}>
                <SelectTrigger><SelectValue/></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— (ambas)</SelectItem>
                  {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpen(false)}>Cancelar</Button>
            <Button onClick={()=>m.mutate()} disabled={!form.email || !form.username || !form.password || m.isPending}>Crear</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
