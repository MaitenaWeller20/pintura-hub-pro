import { StatusPill } from "@/components/app/status-pill";

const PRESENTACION = {
  SIN_FACTURAR: { texto: "Sin facturar", tono: "warning" },
  EMITIENDO: { texto: "Emitiendo", tono: "info" },
  APROBADO: { texto: "Aprobado", tono: "success" },
  ERROR_CORREGIBLE: { texto: "Corregible", tono: "warning" },
  RECONCILIAR: { texto: "Conciliar", tono: "danger" },
  CANCELADO: { texto: "Cancelado", tono: "neutral" },
  BLOQUEADO: { texto: "Bloqueado", tono: "danger" },
  PENDIENTE: { texto: "Legacy pendiente", tono: "warning" },
  ERROR: { texto: "Legacy con error", tono: "danger" },
} as const;

export function EstadoFiscalPill({ estado }: { estado: string }) {
  const vista = PRESENTACION[estado as keyof typeof PRESENTACION] ?? {
    texto: "Estado no reconocido",
    tono: "danger" as const,
  };
  return <StatusPill tone={vista.tono}>{vista.texto}</StatusPill>;
}
