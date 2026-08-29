import { AlertTriangle, ArrowDown, ReceiptText } from "lucide-react";
import { StatusPill } from "@/components/app/status-pill";
import { fmtMoney } from "@/lib/format";
import { letraDeCbteTipo, tituloDeCbteTipo } from "@/lib/fiscal/codigos";
import type { PreviewEmisionFiscal } from "./dialogo-emision-contract";
import type { ModalidadNcPeriodo, ResolucionNcPeriodo } from "@/lib/fiscal/nota-credito-periodo";

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

function tituloDocumento(cbteTipo: number): string {
  const titulo = tituloDeCbteTipo(cbteTipo).toLocaleLowerCase("es-AR");
  return `${titulo.charAt(0).toLocaleUpperCase("es-AR")}${titulo.slice(1)}`;
}

function etiquetaValidez(preview: PreviewEmisionFiscal): {
  texto: string;
  detalle: string;
  tone: "success" | "warning";
} {
  if (preview.afip_validez === "PRODUCCION") {
    return { texto: "Producción", detalle: "validez legal", tone: "success" };
  }
  if (preview.afip_validez === "SIMULADA") {
    return { texto: "Simulada", detalle: "sin validez legal", tone: "warning" };
  }
  return { texto: "Homologación", detalle: "sin validez legal", tone: "warning" };
}

export function ResumenEmisionFiscal({
  preview,
  comprador,
  requiereSegundaConfirmacion = false,
  asociacionPeriodo,
}: {
  preview: PreviewEmisionFiscal;
  comprador: string;
  requiereSegundaConfirmacion?: boolean;
  asociacionPeriodo?: {
    desde: string;
    hasta: string;
    modalidad: ModalidadNcPeriodo;
    motivo: string;
    resolucion: ResolucionNcPeriodo;
    detalleAutoritativo?: {
      neto: string;
      iva: string;
      total: string;
      concepto: string | null;
      alicuotas: readonly { base: string; porcentaje: string; iva: string }[];
      reintegros: readonly { formaPago: string; monto: string }[];
    } | null;
  } | null;
}) {
  const validez = etiquetaValidez(preview);
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
          <StatusPill tone={validez.tone}>
            {validez.texto} · {validez.detalle}
          </StatusPill>
          <span className="rounded-md bg-primary px-2.5 py-1 text-sm font-bold text-primary-foreground">
            {tituloDocumento(preview.cbte_tipo)} {preview.letra}
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
            detalle={`${preview.receptor.tipoDocumento} ${preview.receptor.numeroDocumento ?? "sin identificar"} · ${preview.receptor.condicionIva} · Domicilio fiscal: ${preview.receptor.domicilio ?? "no informado"}`}
          />
          <ArrowDown aria-hidden className="ml-4 h-3 w-3 text-muted-foreground" />
          <PasoIdentidad
            etiqueta="Emisor"
            principal={preview.emisor_razon_social}
            detalle={`CUIT ${preview.emisor_cuit} · ${preview.sucursal_nombre} · PV ${String(preview.punto_venta).padStart(5, "0")}`}
          />
        </div>

        {preview.cbte_asoc ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Comprobante asociado (CbteAsoc)
            </p>
            <p className="mt-1 font-medium">
              {tituloDocumento(preview.cbte_asoc.tipo)} {letraDeCbteTipo(preview.cbte_asoc.tipo)} ·
              PV {String(preview.cbte_asoc.punto_venta).padStart(5, "0")} · N°{" "}
              {String(preview.cbte_asoc.numero).padStart(8, "0")} ·{" "}
              {fechaArgentina(preview.cbte_asoc.fecha)}
            </p>
          </div>
        ) : null}

        {asociacionPeriodo ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Asociación fiscal por período
            </p>
            <p className="mt-1 font-medium">
              {fechaArgentina(asociacionPeriodo.desde)} a {fechaArgentina(asociacionPeriodo.hasta)}{" "}
              ·{" "}
              {asociacionPeriodo.modalidad === "DEVOLUCION_PRODUCTOS"
                ? "Devolución de productos"
                : "Bonificación o ajuste"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {asociacionPeriodo.motivo} ·{" "}
              {asociacionPeriodo.resolucion === "REINTEGRO" ? "Reintegro exacto" : "Saldo a favor"}
            </p>
            <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Importe fiscal</dt>
                <dd className="font-mono font-semibold tabular-nums">{fmtMoney(preview.total)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Receptor resuelto</dt>
                <dd className="font-medium">{preview.receptor.razonSocial}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Letra resuelta</dt>
                <dd className="font-medium">{preview.letra}</dd>
              </div>
            </dl>
            {asociacionPeriodo.detalleAutoritativo ? (
              <div className="mt-3 rounded-md border border-primary/20 bg-background/60 p-2 text-xs">
                <dl className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">Neto autoritativo</dt>
                    <dd className="font-mono font-medium">
                      {fmtMoney(asociacionPeriodo.detalleAutoritativo.neto)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">IVA autoritativo</dt>
                    <dd className="font-mono font-medium">
                      {fmtMoney(asociacionPeriodo.detalleAutoritativo.iva)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Total autoritativo</dt>
                    <dd className="font-mono font-semibold">
                      {fmtMoney(asociacionPeriodo.detalleAutoritativo.total)}
                    </dd>
                  </div>
                </dl>
                {asociacionPeriodo.detalleAutoritativo.concepto ? (
                  <p className="mt-2 text-muted-foreground">
                    Ajuste: {asociacionPeriodo.detalleAutoritativo.concepto}
                  </p>
                ) : null}
                {asociacionPeriodo.detalleAutoritativo.alicuotas.map((alicuota) => (
                  <p
                    key={`${alicuota.base}-${alicuota.porcentaje}`}
                    className="mt-1 text-muted-foreground"
                  >
                    Base {fmtMoney(alicuota.base)} · IVA {alicuota.porcentaje}%{" "}
                    {fmtMoney(alicuota.iva)}
                  </p>
                ))}
                {asociacionPeriodo.resolucion === "REINTEGRO" ? (
                  <div className="mt-2">
                    <p className="font-medium">Liquidación planificada</p>
                    {asociacionPeriodo.detalleAutoritativo.reintegros.map((reintegro) => (
                      <p
                        key={`${reintegro.formaPago}-${reintegro.monto}`}
                        className="text-muted-foreground"
                      >
                        {reintegro.formaPago} · {fmtMoney(reintegro.monto)}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    Saldo a favor planificado ·{" "}
                    {fmtMoney(asociacionPeriodo.detalleAutoritativo.total)}
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

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
            <dd className="font-mono tabular-nums">{fmtMoney(preview.saldo)}</dd>
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
