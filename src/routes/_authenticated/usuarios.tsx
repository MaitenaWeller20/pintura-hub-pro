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
import { Plus, Power, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearUsuario, toggleUsuarioActivo, resetearPassword, setPermiteVentaSinStock, setSeccionesUsuario } from "@/lib/usuarios.functions";
import { GRUPOS, SECCIONES_DEFAULT, SECCIONES_OTORGABLES } from "@/lib/secciones";
import { faltanteUsuario, generarPassword, PASSWORD_MINIMO } from "@/lib/alta-usuario";

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
  const formVacio = { email:"", password:"", username:"", nombre_completo:"", role:"empleado", sucursal_id: null, permite_venta_sin_stock: false };
  const [form, setForm] = useState<any>(formVacio);
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const m = useMutation({
    mutationFn: async () => crear({ data: form }),
    onSuccess: (r: any) => {
      toast.success("Usuario creado");
      qc.invalidateQueries({ queryKey:["usuarios"] });
      setOpen(false);
      const creado = { ...form, id: r?.id, secciones: null };
      setForm(formVacio);
      // Se abre solo el diálogo de permisos: crear el usuario y elegir qué ve
      // son un mismo momento, y si no se ofrece nadie va a ir a buscarlo.
      if (r?.id && form.role !== "admin") setPermisosUser(creado);
    },
    onError: (e:any) => toast.error(e.message),
  });

  const [resetUser, setResetUser] = useState<any>(null);
  const [permisosUser, setPermisosUser] = useState<any>(null);
  const faltante = faltanteUsuario(form);

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
              {/* El permiso de venta sin stock vivía acá como un ícono cuyo
                  único indicio era el title. Se mudó adentro del diálogo de
                  permisos, que es donde alguien lo va a buscar. */}
              <Button size="sm" variant="ghost" title="Permisos y secciones" onClick={()=>setPermisosUser(u)}>
                <ShieldCheck className={`h-3.5 w-3.5 ${u.secciones ? "text-primary" : "text-muted-foreground/60"}`}/>
              </Button>
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
            <div>
              <Label>Contraseña *</Label>
              <div className="flex gap-2">
                <Input className="font-mono" value={form.password} onChange={(e)=>set("password", e.target.value)} autoComplete="new-password"/>
                <Button variant="outline" size="icon" onClick={()=>set("password", generarPassword())} title="Generar una fuerte">
                  <RefreshCw className="h-4 w-4"/>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Mínimo {PASSWORD_MINIMO} caracteres. Copiala antes de crear: no se puede volver a ver.
              </p>
            </div>
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
            <label className="flex items-center gap-2 text-sm border border-border rounded p-2 bg-muted/30">
              <input type="checkbox" checked={!!form.permite_venta_sin_stock} onChange={(e)=>set("permite_venta_sin_stock", e.target.checked)} />
              <span><strong>Puede vender sin stock</strong> — registra ventas de productos sin stock disponible. Los administradores siempre pueden.</span>
            </label>
          </div>
          {/* El motivo por el que no se puede crear, SIEMPRE visible. Un botón
              gris sin explicación fue exactamente el reporte que llegó. */}
          {faltante && <p className="text-sm text-destructive">{faltante}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={()=>setOpen(false)}>Cancelar</Button>
            <Button onClick={()=>m.mutate()} disabled={!!faltante || m.isPending}>
              {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1"/>} Crear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {resetUser && (
        <ResetPasswordDialog usuario={resetUser} onClose={()=>setResetUser(null)} />
      )}

      {permisosUser && (
        <PermisosDialog usuario={permisosUser} onClose={()=>setPermisosUser(null)} />
      )}
    </div>
  );
}

/**
 * Qué pantallas ve un usuario, y el permiso de vender sin stock.
 *
 * Los dos son "permisos" pero NO son la misma cosa, y el diálogo lo separa a
 * propósito: las secciones ordenan lo que ve, y vender sin stock cambia lo que
 * el servidor lo deja hacer. Mezclarlos en una sola grilla haría creer que
 * destildar "Reportes" le saca a alguien el acceso a la plata, y no es así.
 */
function PermisosDialog({ usuario, onClose }: { usuario: any; onClose: () => void }) {
  const qc = useQueryClient();
  const guardarSecciones = useServerFn(setSeccionesUsuario);
  const guardarSinStock = useServerFn(setPermiteVentaSinStock);
  const esAdmin = usuario.role === "admin";

  // null = "las de siempre". El radio es el que decide entre null y una lista.
  const [aMano, setAMano] = useState<boolean>(usuario.secciones != null);
  const [elegidas, setElegidas] = useState<string[]>(usuario.secciones ?? SECCIONES_DEFAULT);
  const [sinStock, setSinStock] = useState<boolean>(!!usuario.permite_venta_sin_stock);

  const toggle = (key: string) =>
    setElegidas((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const m = useMutation({
    mutationFn: async () => {
      // Se escribe SÓLO lo que cambió. Si siempre se mandaran las dos cosas, un
      // admin que abre el diálogo, se va a hacer otra cosa, y vuelve a guardar
      // habiendo tocado nada más que "vender sin stock", pisaría las secciones
      // con el snapshot viejo — borrando lo que otro admin haya cambiado en el
      // medio.
      const seccionesNuevas = aMano ? elegidas : null;
      const cambiaronSecciones =
        JSON.stringify(seccionesNuevas) !== JSON.stringify(usuario.secciones ?? null);

      // El permiso de negocio primero: si algo falla, es preferible que quede
      // sin aplicar el cambio cosmético y no al revés.
      if (sinStock !== !!usuario.permite_venta_sin_stock) {
        await guardarSinStock({ data: { user_id: usuario.id, valor: sinStock } });
      }
      if (cambiaronSecciones) {
        await guardarSecciones({ data: { user_id: usuario.id, secciones: seccionesNuevas } });
      }
    },
    onSuccess: () => {
      toast.success("Permisos actualizados");
      qc.invalidateQueries({ queryKey: ["usuarios"] });
      onClose();
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Permisos de {usuario.username}</DialogTitle></DialogHeader>

        <p className="text-xs text-muted-foreground">
          Esto ordena <strong>qué pantallas ve</strong>. Los permisos de fondo —quién puede
          borrar, quién ve la plata— los sigue mandando el rol.
        </p>

        {esAdmin ? (
          <p className="text-sm border border-border rounded p-3 bg-muted/30">
            Es <strong>administrador</strong>: ve todas las secciones y no se le pueden recortar.
            Para limitarlo, cambiale el rol a empleado.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" checked={!aMano} onChange={() => setAMano(false)} className="mt-1" />
                <span>
                  <strong>Las de siempre</strong>
                  <span className="block text-xs text-muted-foreground">
                    Todo menos Reportes, Facturación y Usuarios. Si más adelante se agrega una
                    pantalla nueva, también la va a ver.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" checked={aMano} onChange={() => setAMano(true)} className="mt-1" />
                <span><strong>Elegir a mano</strong></span>
              </label>
            </div>

            <div className={aMano ? "space-y-3" : "space-y-3 opacity-40 pointer-events-none"}>
              {GRUPOS.map((grupo) => {
                const items = SECCIONES_OTORGABLES.filter((s) => s.grupo === grupo);
                if (items.length === 0) return null;
                return (
                  <div key={grupo}>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                      {grupo}
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      {items.map((s) => (
                        <label key={s.key} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input
                            type="checkbox"
                            checked={elegidas.includes(s.key)}
                            onChange={() => toggle(s.key)}
                            data-testid={`seccion-${s.key}`}
                          />
                          <span>{s.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <label className="flex items-start gap-2 text-sm border border-border rounded p-2 bg-muted/30 cursor-pointer">
              <input
                type="checkbox"
                checked={sinStock}
                onChange={(e) => setSinStock(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <strong>Puede vender sin stock</strong>
                <span className="block text-xs text-muted-foreground">
                  Éste no es de pantallas: cambia lo que el sistema lo deja hacer. Le permite
                  registrar ventas de productos sin stock disponible. Los administradores siempre
                  pueden.
                </span>
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={esAdmin || m.isPending}>
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Cambio de contraseña. Las 5 originales quedaron quemadas (estaban impresas en el login). */
function ResetPasswordDialog({ usuario, onClose }: { usuario: any; onClose: () => void }) {
  const reset = useServerFn(resetearPassword);
  const [password, setPassword] = useState("");

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
              <Button variant="outline" size="icon" onClick={() => setPassword(generarPassword())} title="Generar una fuerte">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Mínimo {PASSWORD_MINIMO} caracteres. Copiala antes de guardar: no se puede volver a ver.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => m.mutate()} disabled={password.length < PASSWORD_MINIMO || m.isPending}>
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Cambiar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
