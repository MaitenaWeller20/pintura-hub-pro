import { History } from "lucide-react";
import { fmtDate } from "@/lib/format";
import type { CambioCorreccionIngreso } from "@/lib/correccion-ingreso";

export type CorreccionIngresoVisible = {
  id: string;
  corregidoPor: string;
  corregidoEn: string;
  motivo: string;
  cambios: CambioCorreccionIngreso[];
};

function fmtCantidad(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(value);
}

function fmtDelta(value: number) {
  return `${value > 0 ? "+" : ""}${fmtCantidad(value)}`;
}

export function HistorialCorreccionesIngreso({
  correcciones,
}: {
  correcciones: CorreccionIngresoVisible[];
}) {
  if (correcciones.length === 0) return null;

  return (
    <section className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-950">
        <History className="h-4 w-4" /> Historial de correcciones
      </h3>
      <div className="space-y-3">
        {correcciones.map((correccion) => (
          <article key={correccion.id} className="rounded-md border bg-background p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-1">
              <p className="font-medium">{correccion.corregidoPor}</p>
              <time className="text-xs text-muted-foreground" dateTime={correccion.corregidoEn}>
                {fmtDate(correccion.corregidoEn)}
              </time>
            </div>
            <p className="mt-1 text-muted-foreground">Motivo: {correccion.motivo}</p>
            <ul className="mt-2 divide-y">
              {correccion.cambios.map((cambio) => (
                <li
                  key={cambio.itemId}
                  className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                >
                  <span>{cambio.descripcion}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {fmtCantidad(cambio.cantidadAnterior)} → {fmtCantidad(cambio.cantidadNueva)} ·{" "}
                    <span className={cambio.delta < 0 ? "text-destructive" : "text-emerald-700"}>
                      {fmtDelta(cambio.delta)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
