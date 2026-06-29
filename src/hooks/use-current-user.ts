/** Estado del usuario logueado: session, profile, role y sucursal. */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

export interface ProfileWithRole {
  user: User;
  profile: {
    id: string;
    username: string;
    nombre_completo: string | null;
    sucursal_id: string | null;
  };
  sucursal: { id: string; codigo: string; nombre: string; numero: string } | null;
  role: "admin" | "empleado" | null;
  isAdmin: boolean;
}

export function useCurrentUser() {
  const [data, setData] = useState<ProfileWithRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async (user: User | null) => {
      if (!user) {
        if (mounted) { setData(null); setLoading(false); }
        return;
      }
      const [{ data: prof }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id, username, nombre_completo, sucursal_id").eq("id", user.id).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", user.id),
      ]);

      let sucursal = null;
      if (prof?.sucursal_id) {
        const { data: s } = await supabase
          .from("sucursales").select("id, codigo, nombre, numero").eq("id", prof.sucursal_id).maybeSingle();
        sucursal = s ?? null;
      }
      const role = (roles?.[0]?.role ?? null) as "admin" | "empleado" | null;
      if (mounted) {
        setData({
          user,
          profile: prof ?? { id: user.id, username: user.email ?? "", nombre_completo: null, sucursal_id: null },
          sucursal,
          role,
          isAdmin: role === "admin",
        });
        setLoading(false);
      }
    };

    supabase.auth.getUser().then(({ data: { user } }) => load(user));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        load(session?.user ?? null);
      }
    });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  return { data, loading };
}
