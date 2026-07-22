/** Server fn admin: crear usuario nuevo */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const crearUsuario = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    email: z.string().email(),
    password: z.string().min(6),
    username: z.string().min(2),
    nombre_completo: z.string(),
    role: z.enum(["admin","empleado"]),
    sucursal_id: z.string().uuid().nullable(),
    permite_venta_sin_stock: z.boolean().default(false),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email, password: data.password, email_confirm: true,
      user_metadata: { username: data.username, nombre_completo: data.nombre_completo },
    });
    if (error || !created.user) throw new Error(error?.message ?? "No se pudo crear");

    await supabaseAdmin.from("profiles").update({
      username: data.username, nombre_completo: data.nombre_completo, sucursal_id: data.sucursal_id,
      permite_venta_sin_stock: data.permite_venta_sin_stock,
    }).eq("id", created.user.id);
    await supabaseAdmin.from("user_roles").insert({ user_id: created.user.id, role: data.role });
    return { id: created.user.id };
  });

export const toggleUsuarioActivo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ user_id: z.string().uuid(), activo: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("profiles").update({ activo: data.activo }).eq("id", data.user_id);
    await supabaseAdmin.auth.admin.updateUserById(data.user_id, { ban_duration: data.activo ? "none" : "876000h" });
    return { ok: true };
  });

/** Server fn admin: habilita/deshabilita que un usuario venda productos sin stock (R6). */
export const setPermiteVentaSinStock = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ user_id: z.string().uuid(), valor: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("profiles")
      .update({ permite_venta_sin_stock: data.valor }).eq("id", data.user_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/**
 * Cambia la contraseña de un usuario.
 *
 * Existe porque las 5 contraseñas originales estuvieron publicadas en la pantalla
 * de login (admin1234 / emp1234), así que están todas quemadas y hay que poder
 * rotarlas sin meterse en la base.
 */
export const resetearPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        user_id: z.string().uuid(),
        password: z.string().min(10, "Mínimo 10 caracteres"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Solo admin");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
