import {
  createFileRoute,
  Outlet,
  redirect,
  Link,
  useRouterState,
  useNavigate,
} from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { perfilHabilitaSesion, useCurrentUser } from "@/hooks/use-current-user";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Boxes,
  Users,
  Truck,
  Wallet,
  Coins,
  BarChart3,
  UserCog,
  Paintbrush,
  LogOut,
  Building2,
  Receipt,
  FileCheck2,
  Calculator,
  ShoppingBag,
  Banknote,
  FileText,
  Lock,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Cargando } from "@/components/app/cargando";
import {
  GRUPOS,
  SECCIONES,
  primeraSeccion,
  puedeAbrirRuta,
  seccionDeRuta,
  seccionesDe,
} from "@/lib/secciones";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    const { data: perfil, error: perfilError } = await supabase
      .from("profiles")
      .select("activo")
      .eq("id", data.user.id)
      .maybeSingle();
    if (!perfilHabilitaSesion(perfil, perfilError)) {
      await supabase.auth.signOut();
      throw redirect({ to: "/auth" });
    }
  },
  component: AuthenticatedLayout,
  pendingComponent: Cargando,
});

// La lista de secciones vive en src/lib/secciones.ts, compartida con el guard de
// ruta y con la pantalla de permisos. Acá queda sólo el ícono de cada una: si el
// menú tuviera su propia lista, el permiso ocultaría el link pero la URL escrita
// a mano seguiría entrando — que es el bug clásico de esta feature.
const ICONOS: Record<string, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  ventas: ShoppingCart,
  presupuestos: FileText,
  remitos: Truck,
  productos: Package,
  stock: Boxes,
  clientes: Users,
  compras: ShoppingBag,
  ingresos_mercaderia: Truck,
  proveedores: Building2,
  // "Pagos a proveedores" completo, no "Pagos": /pagos es la plata que ENTRA
  // de los clientes. Nombres parecidos, cosas opuestas.
  pagos_proveedores: Banknote,
  gastos: Banknote,
  pagos: Wallet,
  cuentas_corrientes: Receipt,
  arqueo: Coins,
  reportes: BarChart3,
  facturacion: FileCheck2,
  usuarios: UserCog,
};

function isActive(to: string, path: string) {
  return to === "/" ? path === "/" : path === to || path.startsWith(to + "/");
}

/**
 * Cambiar en qué sucursal está trabajando, para quien trabaja en más de una.
 *
 * Sólo aparece si tiene más de una habilitada. La barrera real está en la base
 * (el trigger `guard_profiles_columnas`): esto es la comodidad, no la seguridad.
 */
function SelectorSucursal({ cu }: { cu: NonNullable<ReturnType<typeof useCurrentUser>["data"]> }) {
  const [cambiando, setCambiando] = useState(false);

  const cambiar = async (id: string) => {
    if (id === cu.sucursal?.id) return;
    setCambiando(true);
    const { error } = await supabase.rpc("cambiar_sucursal_activa", { p_sucursal_id: id });
    if (error) {
      setCambiando(false);
      toast.error(error.message);
      return;
    }
    // Recarga entera, no invalidación selectiva: las queryKeys de ventas,
    // presupuestos, remitos y compras no incluyen la sucursal, así que sin esto
    // quedarían a la vista filas de la sucursal anterior. La RLS protege la
    // próxima consulta, pero no borra lo que el navegador ya tiene.
    window.location.reload();
  };

  return (
    <div className="mt-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        Trabajando en
      </p>
      <Select value={cu.sucursal?.id ?? ""} onValueChange={cambiar} disabled={cambiando}>
        <SelectTrigger className="h-8 text-xs" data-testid="selector-sucursal">
          <SelectValue placeholder="Elegí…" />
        </SelectTrigger>
        <SelectContent>
          {cu.sucursalesHabilitadas.map((s) => (
            <SelectItem key={s.id} value={s.id} className="text-xs">
              {s.nombre}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function AuthenticatedLayout() {
  const { data: cu, loading } = useCurrentUser();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  const permisos = {
    isAdmin: !!cu?.isAdmin,
    secciones: cu?.secciones ?? null,
    puedeFacturar: cu?.puedeFacturar ?? false,
    facturacionV2Habilitada: cu?.facturacionV2Habilitada ?? false,
  };
  const permitidas = cu ? new Set(seccionesDe(permisos)) : new Set<string>();
  const seccionActual = seccionDeRuta(path);
  // Una ruta nueva sin catálogo ni capacidad explícita falla cerrado. La única
  // excepción es /caja, alias intencional de /arqueo resuelto por puedeAbrirRuta.
  const sinAcceso = !!cu && !puedeAbrirRuta(path, permisos);
  const aterrizaje = cu ? primeraSeccion(permisos) : null;

  // Si entra a "/" y no tiene el dashboard, se lo manda a la primera pantalla
  // que sí tenga. Mostrarle el panel de "sin acceso" apenas se loguea sería
  // técnicamente correcto y prácticamente inservible.
  useEffect(() => {
    if (path === "/" && sinAcceso && aterrizaje) navigate({ to: aterrizaje.ruta });
  }, [path, sinAcceso, aterrizaje, navigate]);

  if (loading) return <Cargando />;
  if (!cu) return null;

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  const current = seccionActual;

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <div className="flex items-center gap-2 px-2 py-2">
              <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <Paintbrush className="h-4 w-4 text-primary-foreground" />
              </div>
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="font-semibold text-sm truncate">PinturaGest</div>
                <div className="text-[10px] text-muted-foreground truncate">CasaForma</div>
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            {GRUPOS.map((grupo) => {
              const items = SECCIONES.filter((s) => s.grupo === grupo && permitidas.has(s.key));
              if (items.length === 0) return null;
              return (
                <SidebarGroup key={grupo}>
                  <SidebarGroupLabel>{grupo}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {items.map((item) => {
                        const Icono = ICONOS[item.key] ?? LayoutDashboard;
                        return (
                          <SidebarMenuItem key={item.key}>
                            <SidebarMenuButton asChild isActive={isActive(item.ruta, path)}>
                              <Link to={item.ruta}>
                                <Icono className="h-4 w-4" />
                                <span>{item.label}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              );
            })}
          </SidebarContent>

          <SidebarFooter>
            <div className="px-2 py-2 text-xs group-data-[collapsible=icon]:hidden">
              <div className="font-medium truncate">
                {cu.profile.nombre_completo || cu.profile.username}
              </div>
              <div className="flex items-center gap-1.5 mt-1">
                <Badge
                  variant={cu.isAdmin ? "default" : "secondary"}
                  className="text-[10px] px-1.5 py-0"
                >
                  {cu.isAdmin ? "ADMIN" : "EMPLEADO"}
                </Badge>
                {cu.sucursal && cu.sucursalesHabilitadas.length <= 1 && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Building2 className="h-3 w-3" /> {cu.sucursal.nombre}
                  </span>
                )}
              </div>

              {/* Quien trabaja en más de una sucursal la elige acá. La que está
                  activa manda en todo: dónde se descuenta el stock, qué caja
                  recibe la plata y qué numeración toma el comprobante. Por eso
                  se muestra siempre, no escondida en un menú. */}
              {cu.sucursalesHabilitadas.length > 1 && <SelectorSucursal cu={cu} />}
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2 justify-start"
                onClick={handleLogout}
              >
                <LogOut className="h-3.5 w-3.5 mr-2" /> Salir
              </Button>
            </div>
          </SidebarFooter>
        </Sidebar>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 flex items-center border-b border-border px-3 gap-2 bg-card">
            <SidebarTrigger />
            <nav className="flex items-center gap-1.5 text-sm min-w-0">
              <span className="text-muted-foreground">CasaForma</span>
              {current && (
                <>
                  <span className="text-muted-foreground/50">/</span>
                  <span className="font-medium truncate">{current.label}</span>
                </>
              )}
            </nav>
            <div className="flex-1" />
            {cu.sucursal && !cu.isAdmin && (
              <Badge variant="outline" className="gap-1">
                <Building2 className="h-3 w-3" />
                {cu.sucursal.nombre}
              </Badge>
            )}
          </header>
          <main className="flex-1 overflow-auto p-4 md:p-6">
            {/* Un panel y no un redirect: el guard de sesión ya redirige desde
                beforeLoad, y encadenar dos redirects es la receta del loop. */}
            {sinAcceso ? (
              <div className="max-w-md mx-auto mt-12 text-center space-y-3">
                <Lock className="h-8 w-8 mx-auto text-muted-foreground" />
                <h2 className="text-lg font-semibold">No tenés acceso a esta pantalla</h2>
                {aterrizaje ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Tu usuario no tiene habilitada la sección{" "}
                      <strong>{seccionActual?.label}</strong>. Si la necesitás, pedísela a un
                      administrador.
                    </p>
                    <Button onClick={() => navigate({ to: aterrizaje.ruta })}>
                      Ir a {aterrizaje.label}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Tu usuario no tiene <strong>ninguna</strong> sección habilitada. Pedile a un
                    administrador que te habilite alguna.
                  </p>
                )}
              </div>
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
