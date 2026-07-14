import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableRow, TableCell } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { StatusPill } from "@/components/app/status-pill";
import { Plus, Power, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearUsuario, toggleUsuarioActivo, resetearPassword } from "@/lib/usuarios.functions";

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

  const { data: usuarios = [], isLoading } = useQuery({
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

  // Antes esto venía precargado con "emp1234" — la misma contraseña débil que
  // estuvo publicada en la pantalla de login. Cada usuario nuevo nacía quemado.
  const formVacio = { email:"", password:"", username:"", nombre_completo:"", role:"empleado", sucursal_id: null };
  const [form, setForm] = useState<any>(formVacio);
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const m = useMutation({
    mutationFn: async () => crear({ data: form }),
    onSuccess: () => { toast.success("Usuario creado"); qc.invalidateQueries({ queryKey:["usuarios"] }); setOpen(false);
      setForm(formVacio); },
    onError: (e:any) => toast.error(e.message),
  });

  const [resetUser, setResetUser] = useState<any>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Usuarios"
        actions={<Button onClick={()=>setOpen(true)}><Plus className="h-4 w-4 mr-1"/> Nuevo</Button>}
      />

      <DataTable
        columns={["Usuario", "Nombre", "Rol", "Sucursal", "Estado", ""]}
        loading={isLoading}
        isEmpty={usuarios.length === 0}
        empty={{ text: "No hay usuarios." }}
      >
        {usuarios.map((u:any)=>(
          <TableRow key={u.id}>
            <TableCell className="font-mono text-xs">{u.username}</TableCell>
            <TableCell>{u.nombre_completo ?? "—"}</TableCell>
            <TableCell>
              <StatusPill tone={u.role === "admin" ? "info" : "neutral"}>{u.role ?? "—"}</StatusPill>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">{u.sucursal?.nombre ?? "—"}</TableCell>
            <TableCell>{u.activo ? <StatusPill tone="success">Activo</StatusPill> : <StatusPill tone="neutral">Inactivo</StatusPill>}</TableCell>
            <TableCell className="flex gap-1">
              <Button size="sm" variant="ghost" title="Cambiar contraseña" onClick={()=>setResetUser(u)}>
                <KeyRound className="h-3.5 w-3.5"/>
              </Button>
              <Button size="sm" variant="ghost" title={u.activo ? "Desactivar" : "Activar"} onClick={()=>togg.mutate({ user_id: u.id, activo: !u.activo })}>
                <Power className="h-3.5 w-3.5"/>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

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
            <Button onClick={()=>m.mutate()} disabled={!form.email || !form.username || form.password.length < 10 || m.isPending}>Crear</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {resetUser && (
        <ResetPasswordDialog usuario={resetUser} onClose={()=>setResetUser(null)} />
      )}
    </div>
  );
}

/** Cambio de contraseña. Las 5 originales quedaron quemadas (estaban impresas en el login). */
function ResetPasswordDialog({ usuario, onClose }: { usuario: any; onClose: () => void }) {
  const reset = useServerFn(resetearPassword);
  const [password, setPassword] = useState("");

  const generar = () => {
    const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
    const bytes = crypto.getRandomValues(new Uint32Array(16));
    setPassword(Array.from(bytes, (b) => abc[b % abc.length]).join(""));
  };

  const m = useMutation({
    mutationFn: async () => reset({ data: { user_id: usuario.id, password } }),
    onSuccess: () => {
      toast.success(`Contraseña de ${usuario.username} cambiada. Pasásela por un canal privado.`, { duration: 8000 });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Contraseña de {usuario.username}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Nueva contraseña *</Label>
            <div className="flex gap-2">
              <Input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono"
                autoComplete="new-password"
              />
              <Button variant="outline" size="icon" onClick={generar} title="Generar una fuerte">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Mínimo 10 caracteres. Copiala antes de guardar: no se puede volver a ver.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={password.length < 10 || m.isPending}>
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Cambiar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
