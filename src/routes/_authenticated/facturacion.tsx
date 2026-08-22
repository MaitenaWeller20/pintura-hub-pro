import { createFileRoute, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { EmisoresConfig } from "@/components/app/emisores-config";
import { CredencialesArcaConfig } from "@/components/app/credenciales-arca-config";

export const Route = createFileRoute("/_authenticated/facturacion")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });

    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", data.user.id);
    if (!roles?.some((role) => role.role === "admin")) throw redirect({ to: "/" });
  },
  component: FacturacionPage,
});

function FacturacionPage() {
  return (
    <div className="max-w-5xl space-y-4">
      <PageHeader
        title="Facturación electrónica"
        subtitle="Identidad fiscal, puntos de venta y credenciales ARCA separados por empresa."
      />
      <EmisoresConfig esAdmin />
      <CredencialesArcaConfig />
    </div>
  );
}
