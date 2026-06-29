/**
 * Setup inicial: crea los 5 usuarios precargados con sus roles y sucursales.
 * Idempotente: si ya existen, no hace nada. Pensado para correr una sola vez
 * desde la UI o cuando alguien intenta loguearse y aún no hay usuarios.
 */
import { createServerFn } from "@tanstack/react-start";

const USERS = [
  { email: "maitenaweller2004@gmail.com", password: "admin1234",
    username: "admin", nombre: "Administrador", role: "admin" as const, sucursal: null },
  { email: "silvia@casa-forma.com", password: "emp1234",
    username: "empleado_ohiggins1", nombre: "Empleado O'Higgins 1", role: "empleado" as const, sucursal: "OHIGGINS" as const },
  { email: "ohiggins2@casaforma.local", password: "emp1234",
    username: "empleado_ohiggins2", nombre: "Empleado O'Higgins 2", role: "empleado" as const, sucursal: "OHIGGINS" as const },
  { email: "generalpaz1@casaforma.local", password: "emp1234",
    username: "empleado_generalpaz1", nombre: "Empleado General Paz 1", role: "empleado" as const, sucursal: "GENERALPAZ" as const },
  { email: "generalpaz2@casaforma.local", password: "emp1234",
    username: "empleado_generalpaz2", nombre: "Empleado General Paz 2", role: "empleado" as const, sucursal: "GENERALPAZ" as const },
];

export const seedInitialUsers = createServerFn({ method: "POST" })
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Sucursales por código
    const { data: sucs, error: sucErr } = await supabaseAdmin
      .from("sucursales")
      .select("id, codigo");
    if (sucErr) throw new Error(sucErr.message);
    const sucMap = new Map(sucs!.map((s) => [s.codigo, s.id]));

    const results: Array<{ email: string; status: string }> = [];

    for (const u of USERS) {
      // ¿Ya existe?
      const { data: existing } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("username", u.username)
        .maybeSingle();

      if (existing) {
        results.push({ email: u.email, status: "ya existía" });
        continue;
      }

      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { username: u.username, nombre_completo: u.nombre },
      });
      if (cErr || !created.user) {
        results.push({ email: u.email, status: `error: ${cErr?.message}` });
        continue;
      }
      const uid = created.user.id;

      // El trigger handle_new_user ya creó el profile. Actualizamos sucursal:
      await supabaseAdmin.from("profiles").update({
        username: u.username,
        nombre_completo: u.nombre,
        sucursal_id: u.sucursal ? sucMap.get(u.sucursal) ?? null : null,
      }).eq("id", uid);

      // Rol
      await supabaseAdmin.from("user_roles").insert({ user_id: uid, role: u.role });

      results.push({ email: u.email, status: "creado" });
    }

    return { ok: true, results };
  });
