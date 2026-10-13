import { ArrowRight, History } from "lucide-react";

import { fmtDateTime, fmtMoney, formaPagoLabel } from "@/lib/format";

export type CorreccionPagoVisible = {
  id: number;
  corregidaEn: string;
  corregidaPor: string;
  motivo: string;
  formaAnterior: string;
  formaNueva: string;
  monto: number;
  versionNueva: number;
};

function etiquetaFormaPago(forma: string): string {
  return formaPagoLabel[forma as keyof typeof formaPagoLabel] ?? forma.replaceAll("_", " ");
}

export function HistorialCorreccionesPago({
  correcciones,
}: {
  correcciones: CorreccionPagoVisible[];
}) {
  if (correcciones.length === 0) return null;

  return (
    <section className="mt-4 border-t border-border pt-3" aria-label="Historial de correcciones">
      <h5 className="flex items-center gap-2 text-sm font-semibold">
        <History className="h-4 w-4" aria-hidden="true" /> Historial de correcciones
      </h5>
      <div className="mt-2 space-y-2">
        {correcciones.map((correccion) => (
          <article key={correccion.id} className="rounded-md border border-border p-3 text-xs">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium">
                Versión {correccion.versionNueva} · {correccion.corregidaPor}
              </p>
              <time className="text-muted-foreground" dateTime={correccion.corregidaEn}>
                {fmtDateTime(correccion.corregidaEn)}
              </time>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{etiquetaFormaPago(correccion.formaAnterior)}</span>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="font-semibold">{etiquetaFormaPago(correccion.formaNueva)}</span>
              <span className="ml-auto font-mono tabular-nums">{fmtMoney(correccion.monto)}</span>
            </div>
            <p className="mt-2 text-muted-foreground">
              <span className="font-medium text-foreground">Motivo:</span> {correccion.motivo}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
