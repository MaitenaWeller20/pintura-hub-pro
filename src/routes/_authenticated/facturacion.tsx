import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { PageHeader } from "@/components/app/page-header";
import { cargarAccesoFiscalActual } from "@/hooks/use-current-user";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/facturacion")({
  beforeLoad: async () => {
    const accesoFiscal = await cargarAccesoFiscalActual();
    if (!accesoFiscal) throw redirect({ to: "/auth" });
    return { accesoFiscal };
  },
  component: FacturacionLayout,
});

const enlaceBase =
  "inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function FacturacionLayout() {
  const { accesoFiscal } = Route.useRouteContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const colaActiva = pathname === "/facturacion/cola";
  const configuracionActiva = pathname === "/facturacion/configuracion";

  return (
    <div className="max-w-7xl space-y-4">
      <PageHeader
        title="Facturación electrónica"
        subtitle="Libro fiscal operativo, receptores y configuración ARCA con acceso por capacidad."
      />

      <nav
        aria-label="Secciones de facturación electrónica"
        className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-card p-1 shadow-card"
      >
        {accesoFiscal.facturacionV2Habilitada ? (
          <Link
            to="/facturacion/cola"
            search={{ tab: "pendientes", page: 1 }}
            className={cn(
              enlaceBase,
              colaActiva ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted",
            )}
            aria-current={colaActiva ? "page" : undefined}
          >
            Cola fiscal
          </Link>
        ) : null}
        {accesoFiscal.isAdmin ? (
          <Link
            to="/facturacion/configuracion"
            className={cn(
              enlaceBase,
              configuracionActiva
                ? "bg-primary text-primary-foreground shadow-sm"
                : "hover:bg-muted",
            )}
            aria-current={configuracionActiva ? "page" : undefined}
          >
            Configuración
          </Link>
        ) : null}
      </nav>

      <Outlet />
    </div>
  );
}
