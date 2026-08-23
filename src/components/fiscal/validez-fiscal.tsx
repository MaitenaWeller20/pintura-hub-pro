import { StatusPill } from "@/components/app/status-pill";
import { textoValidezFiscal, type ValidezFiscalTipo } from "@/lib/fiscal/validez-ui";

export function ValidezFiscal({
  validez,
  estado,
  compacta = false,
}: {
  validez: unknown;
  estado?: unknown;
  compacta?: boolean;
}) {
  if (estado === "NO_APLICA") return null;
  const normalizada: ValidezFiscalTipo | null =
    validez === "PRODUCCION" || validez === "HOMOLOGACION" || validez === "SIMULADA"
      ? validez
      : null;
  const texto = textoValidezFiscal(normalizada);
  if (compacta) {
    return (
      <span className="text-xs text-muted-foreground" title={texto}>
        {texto}
      </span>
    );
  }
  return (
    <StatusPill tone={normalizada === "PRODUCCION" ? "success" : "warning"}>{texto}</StatusPill>
  );
}
