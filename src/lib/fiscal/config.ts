import type { AmbienteArca } from "./contexto";

export type CredencialArcaPublica = {
  ambiente: AmbienteArca;
  tiene_clave: boolean;
  tiene_certificado: boolean;
  cert_vence_at: string | null;
  cert_alias: string | null;
  probada_at: string | null;
  habilitada: boolean;
};

export type CredencialArcaSecreta = {
  ambiente: AmbienteArca;
  arca_key_enc: string | null;
  arca_cert_enc: string | null;
  cert_vence_at: string | null;
  cert_alias: string | null;
  probada_at: string | null;
  habilitada: boolean;
};

/** Convierte filas privadas en el único formato que puede llegar al navegador. */
export function normalizarCredencialesPublicas(
  rows: CredencialArcaSecreta[],
): CredencialArcaPublica[] {
  return (["HOMOLOGACION", "PRODUCCION"] as const).map((ambiente) => {
    const row = rows.find((item) => item.ambiente === ambiente);
    return {
      ambiente,
      tiene_clave: Boolean(row?.arca_key_enc),
      tiene_certificado: Boolean(row?.arca_cert_enc),
      cert_vence_at: row?.cert_vence_at ?? null,
      cert_alias: row?.cert_alias ?? null,
      probada_at: row?.probada_at ?? null,
      habilitada: row?.habilitada ?? false,
    };
  });
}

type EstadoPrivadoCredencial = Pick<
  CredencialArcaSecreta,
  "arca_key_enc" | "arca_cert_enc" | "cert_vence_at" | "probada_at"
>;

export function validarHabilitacionCredencial(
  credencial: EstadoPrivadoCredencial,
  habilitada: boolean,
  ahora = new Date(),
): void {
  if (!habilitada) return;
  if (!credencial.arca_key_enc || !credencial.arca_cert_enc) {
    throw new Error("Cargá y verificá el certificado antes de habilitar esta credencial.");
  }
  const vence = credencial.cert_vence_at ? new Date(credencial.cert_vence_at) : null;
  if (!vence || !Number.isFinite(vence.getTime()) || vence <= ahora) {
    throw new Error("El certificado está vencido o no tiene un vencimiento válido.");
  }
  if (!credencial.probada_at) {
    throw new Error("Primero hay que probar la conexión real con ARCA.");
  }
}
