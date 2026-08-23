import { createFileRoute, redirect } from "@tanstack/react-router";
import { EmisoresConfig } from "@/components/app/emisores-config";
import { CredencialesArcaConfig } from "@/components/app/credenciales-arca-config";

export const Route = createFileRoute("/_authenticated/facturacion/configuracion")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const acceso = context.accesoFiscal;
    if (!acceso.isAdmin) throw redirect({ to: "/" });
  },
  component: ConfiguracionFiscalPage,
});

function ConfiguracionFiscalPage() {
  return (
    <div className="space-y-4">
      <EmisoresConfig esAdmin />
      <CredencialesArcaConfig />
    </div>
  );
}
