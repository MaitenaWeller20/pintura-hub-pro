import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/facturacion/")({
  beforeLoad: async ({ context }) => {
    const acceso = context.accesoFiscal;
    if (acceso.facturacionV2Habilitada && (acceso.isAdmin || acceso.puedeFacturar)) {
      throw redirect({ to: "/facturacion/cola", search: { tab: "pendientes", page: 1 } });
    }
    if (acceso.isAdmin) throw redirect({ to: "/facturacion/configuracion" });
    throw redirect({ to: "/" });
  },
});
