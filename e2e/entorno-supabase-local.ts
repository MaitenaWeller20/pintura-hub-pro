type EntornoSupabaseE2E = Record<string, string | undefined>;

export type EntornoSupabaseLocalNormalizado = {
  SUPABASE_URL: string;
  VITE_SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  VITE_SUPABASE_PUBLISHABLE_KEY: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

export function normalizarEntornoSupabaseLocalE2E(
  entorno: EntornoSupabaseE2E,
): EntornoSupabaseLocalNormalizado {
  const url = entorno.SUPABASE_URL ?? entorno.VITE_SUPABASE_URL;
  const anon =
    entorno.SUPABASE_PUBLISHABLE_KEY ??
    entorno.VITE_SUPABASE_PUBLISHABLE_KEY ??
    entorno.SUPABASE_ANON_KEY;
  const serviceRole = entorno.SUPABASE_SERVICE_ROLE_KEY;
  const faltantes = [
    !url && "URL local",
    !anon && "anon/publishable key local",
    !serviceRole && "service-role local",
  ].filter(Boolean);
  if (faltantes.length > 0) {
    throw new Error(`El E2E exige ${faltantes.join(", ")} de Supabase local.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    throw new Error("La URL de Supabase para E2E no es válida.");
  }
  if (!/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
    throw new Error("El E2E sólo puede conectarse a un Supabase local.");
  }
  return {
    SUPABASE_URL: url!,
    VITE_SUPABASE_URL: url!,
    SUPABASE_PUBLISHABLE_KEY: anon!,
    VITE_SUPABASE_PUBLISHABLE_KEY: anon!,
    SUPABASE_ANON_KEY: anon!,
    SUPABASE_SERVICE_ROLE_KEY: serviceRole!,
  };
}
