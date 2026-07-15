import { createFileRoute, Outlet, redirect, Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
  SidebarHeader, SidebarFooter,
} from "@/components/ui/sidebar";
import {
  LayoutDashboard, ShoppingCart, Package, Boxes, Users, Truck, Wallet, Coins, BarChart3,
  UserCog, Paintbrush, LogOut, Building2, Receipt, FileCheck2, Calculator, ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
  component: AuthenticatedLayout,
});

type MenuItem = { to: string; label: string; icon: typeof LayoutDashboard; adminOnly: boolean };

const groups: Array<{ label: string; items: MenuItem[] }> = [
  {
    label: "Operación",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, adminOnly: false },
      { to: "/ventas", label: "Ventas", icon: ShoppingCart, adminOnly: false },
      { to: "/remitos", label: "Remitos", icon: Truck, adminOnly: false },
    ],
  },
  {
    label: "Catálogo",
    items: [
      { to: "/productos", label: "Productos", icon: Package, adminOnly: false },
      { to: "/stock", label: "Stock", icon: Boxes, adminOnly: false },
      { to: "/clientes", label: "Clientes", icon: Users, adminOnly: false },
    ],
  },
  {
    label: "Compras",
    items: [
      { to: "/compras", label: "Compras", icon: ShoppingBag, adminOnly: false },
      { to: "/proveedores", label: "Proveedores", icon: Building2, adminOnly: false },
    ],
  },
  {
    label: "Cobranzas",
    items: [
      { to: "/pagos", label: "Pagos", icon: Wallet, adminOnly: false },
      { to: "/cuentas-corrientes", label: "Cuentas corrientes", icon: Receipt, adminOnly: false },
      { to: "/arqueo", label: "Arqueo de caja", icon: Calculator, adminOnly: false },
      { to: "/caja", label: "Rendición caja", icon: Coins, adminOnly: false },
    ],
  },
  {
    label: "Administración",
    items: [
      { to: "/reportes", label: "Reportes", icon: BarChart3, adminOnly: true },
      { to: "/facturacion", label: "Facturación AFIP", icon: FileCheck2, adminOnly: true },
      { to: "/usuarios", label: "Usuarios", icon: UserCog, adminOnly: true },
    ],
  },
];

const allItems = groups.flatMap((g) => g.items);

function isActive(to: string, path: string) {
  return to === "/" ? path === "/" : path.startsWith(to);
}

function AuthenticatedLayout() {
  const { data: cu, loading } = useCurrentUser();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Cargando…</div>;
  }
  if (!cu) return null;

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  const current = allItems.find((i) => isActive(i.to, path));

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
            {groups.map((group) => {
              const items = group.items.filter((i) => !i.adminOnly || cu.isAdmin);
              if (items.length === 0) return null;
              return (
                <SidebarGroup key={group.label}>
                  <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {items.map((item) => (
                        <SidebarMenuItem key={item.to}>
                          <SidebarMenuButton asChild isActive={isActive(item.to, path)}>
                            <Link to={item.to}>
                              <item.icon className="h-4 w-4" />
                              <span>{item.label}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              );
            })}
          </SidebarContent>

          <SidebarFooter>
            <div className="px-2 py-2 text-xs group-data-[collapsible=icon]:hidden">
              <div className="font-medium truncate">{cu.profile.nombre_completo || cu.profile.username}</div>
              <div className="flex items-center gap-1.5 mt-1">
                <Badge variant={cu.isAdmin ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                  {cu.isAdmin ? "ADMIN" : "EMPLEADO"}
                </Badge>
                {cu.sucursal && (
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Building2 className="h-3 w-3" /> {cu.sucursal.nombre}
                  </span>
                )}
              </div>
              <Button variant="ghost" size="sm" className="w-full mt-2 justify-start" onClick={handleLogout}>
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
              <Badge variant="outline" className="gap-1"><Building2 className="h-3 w-3" />{cu.sucursal.nombre}</Badge>
            )}
          </header>
          <main className="flex-1 overflow-auto p-4 md:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
