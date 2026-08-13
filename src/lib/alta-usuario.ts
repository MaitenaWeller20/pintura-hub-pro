/**
 * Por qué todavía no se puede crear el usuario.
 *
 * Existe porque el botón "Crear" estaba deshabilitado con tres condiciones
 * juntas y ninguna explicada: alguien escribía una contraseña de 4 caracteres,
 * el botón quedaba gris, y no había NADA en pantalla que dijera que el mínimo
 * son 10. El reporte que llegó fue "no me deja crear usuarios".
 *
 * Mismo patrón que `faltanteCompra`: devuelve UN solo motivo —el primero que
 * falta en el orden en que se llenan los campos— para que la pantalla diga qué
 * hacer ahora y no vomite una lista de cinco reglas.
 */

/**
 * Mínimo de caracteres de una contraseña.
 *
 * OJO: este número también vive en `usuarios.functions.ts` (los dos `z.string()`).
 * Hasta el 04/08/2026 el alta validaba 6 en el servidor y 10 en la pantalla, así
 * que el mínimo real dependía de por dónde entrara el pedido.
 */
export const PASSWORD_MINIMO = 10;

/** Suficiente para atajar un tipeo. La validación de verdad la hace Supabase. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FormAltaUsuario = {
  email?: string | null;
  password?: string | null;
  username?: string | null;
  role?: string | null;
  sucursal_id?: string | null;
};

export function faltanteUsuario(f: FormAltaUsuario): string | null {
  const email = (f.email ?? "").trim();
  const password = f.password ?? "";
  const username = (f.username ?? "").trim();

  if (!email) return "Falta el email con el que va a entrar.";
  if (!EMAIL_RE.test(email)) return `"${email}" no parece un email.`;

  if (!password) return `Falta la contraseña (mínimo ${PASSWORD_MINIMO} caracteres).`;
  if (password.length < PASSWORD_MINIMO) {
    // Se dice el número que falta, no la regla: "necesita 10" obliga a contar.
    const faltan = PASSWORD_MINIMO - password.length;
    return `A la contraseña le faltan ${faltan} caracteres (mínimo ${PASSWORD_MINIMO}). Podés usar el botón de generar.`;
  }

  if (!username) return "Falta el usuario (alias): es el nombre corto que se ve en las pantallas.";
  if (username.length < 2) return "El usuario (alias) necesita al menos 2 caracteres.";

  // La etiqueta del campo ya dice "*" cuando el rol es empleado, pero nada lo
  // exigía: se podían crear empleados sin sucursal, y un empleado sin sucursal
  // no tiene caja ni puede vender.
  if (f.role === "empleado" && !f.sucursal_id) {
    return "Un empleado necesita una sucursal: de ahí salen su caja y sus ventas.";
  }

  return null;
}

/**
 * Una contraseña fuerte y tipeable por teléfono.
 *
 * El alfabeto NO tiene l/I/1 ni o/O/0: esta contraseña se dicta por WhatsApp y
 * un cero leído como o es un llamado.
 */
export function generarPassword(largo = 16): string {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*";
  const bytes = crypto.getRandomValues(new Uint32Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
