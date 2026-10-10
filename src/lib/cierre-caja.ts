const centavos = (monto: number) => Math.round((monto + Number.EPSILON) * 100);

export function calcularCierreEfectivo(
  efectivoContado: number | null,
  efectivoRetirado: number | null,
) {
  if (efectivoContado === null || efectivoRetirado === null) {
    return { efectivoDejado: null, valido: false, error: null };
  }
  if (!Number.isFinite(efectivoContado) || !Number.isFinite(efectivoRetirado) ||
      efectivoContado < 0 || efectivoRetirado < 0) {
    return { efectivoDejado: null, valido: false, error: "Ingresá importes válidos y no negativos." };
  }
  const dejadoCentavos = centavos(efectivoContado) - centavos(efectivoRetirado);
  if (dejadoCentavos < 0) {
    return { efectivoDejado: null, valido: false, error: "No podés retirar más efectivo del que contaste." };
  }
  return { efectivoDejado: dejadoCentavos / 100, valido: true, error: null };
}

export function construirCierreCajaRpc({
  sesionId,
  efectivoContado,
  efectivoRetirado,
  notas,
}: {
  sesionId: string;
  efectivoContado: number | null;
  efectivoRetirado: number | null;
  notas: string;
}) {
  const cierre = calcularCierreEfectivo(efectivoContado, efectivoRetirado);
  if (!cierre.valido || cierre.efectivoDejado === null || efectivoContado === null) {
    throw new Error(cierre.error ?? "Completá el efectivo contado y el retirado.");
  }
  return {
    p_sesion_id: sesionId,
    p_contado: { EFECTIVO: efectivoContado },
    p_efectivo_dejado: cierre.efectivoDejado,
    p_notas: notas.trim() || undefined,
  };
}

export function efectivoRetiradoRegistrado(efectivoContado: number, efectivoDejado: number) {
  return (centavos(efectivoContado) - centavos(efectivoDejado)) / 100;
}
