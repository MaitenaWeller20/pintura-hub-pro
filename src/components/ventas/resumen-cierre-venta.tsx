import { ReceiptText } from "lucide-react";
import { fmtMoney } from "@/lib/format";
import { resumirCierreVenta } from "@/lib/ventas-ui";

export function ResumenCierreVenta({
  total,
  pagadoAhora,
  esCtaCte,
}: {
  total: number;
  pagadoAhora: number;
  esCtaCte: boolean;
}) {
  const resumen = resumirCierreVenta({ total, pagadoAhora, esCtaCte });

  return (
    <section
      aria-labelledby="resumen-cierre-venta-titulo"
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-testid="resumen-cierre-venta"
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <ReceiptText className="h-4 w-4 text-primary" />
        <h3 id="resumen-cierre-venta-titulo" className="text-sm font-semibold">
          Resumen del cierre
        </h3>
      </div>
      <dl className="grid gap-3 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted-foreground">Total de la venta</dt>
          <dd className="font-mono text-base font-semibold tabular-nums">
            {fmtMoney(resumen.total)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Cobrado ahora</dt>
          <dd className="font-mono text-base tabular-nums">{fmtMoney(resumen.pagadoAhora)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">
            {resumen.esCtaCte ? "Va a cuenta corriente" : "Saldo pendiente"}
          </dt>
          <dd className="font-mono text-base font-semibold tabular-nums text-warning">
            {fmtMoney(resumen.saldo)}
          </dd>
        </div>
      </dl>
      <p className="border-t border-primary/20 bg-primary/5 px-4 py-3 text-sm font-medium text-foreground">
        La factura se emite por el total. Facturar no cobra ni cancela el saldo.
      </p>
    </section>
  );
}
