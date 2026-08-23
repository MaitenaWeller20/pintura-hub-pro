import { AlertTriangle, ArrowDown, ReceiptText } from "lucide-react";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney } from "@/lib/format";
import type { PreviewEmisionFiscal } from "./dialogo-emision-contract";

export type { PreviewEmisionFiscal } from "./dialogo-emision-contract";

function fechaArgentina(value: string): string {
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function PasoIdentidad({
  etiqueta,
  principal,
  detalle,
}: {
  etiqueta: string;
  principal: string;
  detalle: string;
}) {
  return (
    <div className="relative pl-5">
      <span className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-primary" />
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {etiqueta}
      </p>
      <p className="font-semibold">{principal}</p>
      <p className="text-xs text-muted-foreground">{detalle}</p>
    </div>
  );
}

export function ResumenEmisionFiscal({
  preview,
  comprador,
  emisor,
  sucursal,
  requiereSegundaConfirmacion = false,
}: {
  preview: PreviewEmisionFiscal;
  comprador: string;
  emisor: string;
  sucursal: string;
  requiereSegundaConfirmacion?: boolean;
}) {
  return (
    <section aria-labelledby="resumen-fiscal-titulo" className="rounded-xl border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <ReceiptText className="h-4 w-4 text-primary" />
          <h3 id="resumen-fiscal-titulo" className="text-sm font-semibold">
            Confirmación fiscal
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill tone={preview.modo === "PRODUCCION" ? "success" : "warning"}>
            {preview.modo === "PRODUCCION" ? "Producción" : "Homologación"}
          </StatusPill>
          <span className="rounded-md bg-primary px-2.5 py-1 text-sm font-bold text-primary-foreground">
            Factura {preview.letra}
          </span>
        </div>
      </div>

      <div className="space-y-4 p-4">
        <div className="ml-1 space-y-3 border-l-2 border-primary/35">
          <PasoIdentidad
            etiqueta="Venta y deuda"
            principal={comprador}
            detalle="El cobro y el saldo siguen asociados a este cliente."
          />
          <ArrowDown aria-hidden className="ml-4 h-3 w-3 text-muted-foreground" />
          <PasoIdentidad
            etiqueta="Receptor fiscal"
            principal={preview.receptor.razonSocial}
            detalle={`${preview.receptor.tipoDocumento} ${preview.receptor.numeroDocumento ?? "sin identificar"} · ${preview.receptor.condicionIva}`}
          />
          <ArrowDown aria-hidden className="ml-4 h-3 w-3 text-muted-foreground" />
          <PasoIdentidad
            etiqueta="Emisor"
            principal={emisor}
            detalle={`CUIT ${preview.emisor_cuit} · ${sucursal} · PV ${String(preview.punto_venta).padStart(5, "0")}`}
          />
        </div>

        <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {preview.razon_letra}
        </p>

        {preview.advertencia_demora ? (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{preview.advertencia_demora}</span>
          </div>
        ) : null}

        {requiereSegundaConfirmacion ? (
          <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm font-medium">
            Los datos autoritativos cambiaron. Revisalos y confirmá una segunda vez.
          </div>
        ) : null}

        <dl className="grid gap-3 rounded-lg border border-dashed border-border p-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Fecha comercial</dt>
            <dd className="font-medium">{fechaArgentina(preview.fecha_comercial)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Fecha fiscal</dt>
            <dd className="font-medium">{fechaArgentina(preview.fecha_fiscal)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Total a facturar</dt>
            <dd className="font-mono font-semibold tabular-nums">{fmtMoney(preview.total)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cobrado</dt>
            <dd className="font-mono tabular-nums">{fmtMoney(preview.pagado)}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Saldo comercial</dt>
            <dd className="font-mono tabular-nums">
              {requiereSegundaConfirmacion
                ? "El servidor lo confirmará al emitir"
                : fmtMoney(preview.saldo)}
            </dd>
          </div>
        </dl>

        {preview.letra === "A" && !preview.confirmacion_factura_a_permitida ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            El emisor todavía no tiene confirmada la modalidad Factura A estándar.
          </p>
        ) : null}
      </div>
    </section>
  );
}
