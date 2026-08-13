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
  /** Qué secciones del menú ve. `null` = las de siempre. Ver src/lib/secciones.ts. */
  secciones: string[] | null;
  sucursal: { id: string; codigo: string; nombre: string; numero: string } | null;
  /**
   * En qué sucursales PUEDE trabajar. `sucursal` de arriba es en cuál está
   * trabajando ahora (la activa). Casi todos tienen una sola; quien tenga más
   * ve el selector para cambiarse. Ver la migración 20260813120000.
   */
  sucursalesHabilitadas: Array<{ id: string; nombre: string }>;
  role: "admin" | "empleado" | null;
  isAdmin: boolean;
  /**
   * Espejo de `puede_vender_sin_stock(uid)` en SQL: admin O el permiso del
   * perfil. La guarda de verdad la hace `crear_venta`; esto existe para poder
   * avisar ANTES de que alguien cargue una venta entera que va a ser rechazada.
   */
  puedeVenderSinStock: boolean;
}

export function useCurrentUser() {
  const [data, setData] = useState<ProfileWithRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const load = async (user: User | null) => {
      if (!user) {
        if (mounted) {
          setData(null);
          setLoading(false);
        }
        return;
      }
      const [{ data: prof }, { data: roles }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, username, nombre_completo, sucursal_id, secciones, permite_venta_sin_stock")
          .eq("id", user.id)
          .maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", user.id),
      ]);

      // Las sucursales donde puede trabajar. Se trae siempre: es lo que decide
      // si se le muestra el selector para cambiarse.
      const { data: habilitadas } = await supabase
        .from("profile_sucursales")
        .select("sucursal:sucursales(id, nombre)")
        .eq("profile_id", user.id);
      const sucursalesHabilitadas = ((habilitadas ?? []) as any[])
        .map((h) => h.sucursal)
        .filter(Boolean)
        .sort((a: any, b: any) => a.nombre.localeCompare(b.nombre));

      let sucursal = null;
      if (prof?.sucursal_id) {
        const { data: s } = await supabase
          .from("sucursales")
          .select("id, codigo, nombre, numero")
          .eq("id", prof.sucursal_id)
          .maybeSingle();
        sucursal = s ?? null;
      }
      const role = (roles?.[0]?.role ?? null) as "admin" | "empleado" | null;
      if (mounted) {
        setData({
          user,
          profile: prof ?? {
            id: user.id,
            username: user.email ?? "",
            nombre_completo: null,
            sucursal_id: null,
          },
          secciones: (prof as any)?.secciones ?? null,
          sucursal,
          sucursalesHabilitadas,
          role,
          isAdmin: role === "admin",
          puedeVenderSinStock: role === "admin" || (prof as any)?.permite_venta_sin_stock === true,
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
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { data, loading };
}
