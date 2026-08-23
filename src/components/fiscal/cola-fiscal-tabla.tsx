import { AlertTriangle, ArrowRight, FileSearch, Loader2, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDate, fmtMoney } from "@/lib/format";
import type { ColaFiscalFila } from "@/lib/fiscal/cola.functions";
import { clasificarInteraccionCola, presentarEstadoColaFiscal } from "@/lib/fiscal/cola-ui";
import { EstadoFiscalPill } from "./estado-fiscal-pill";
import { ValidezFiscal } from "./validez-fiscal";

function fecha(value: string | null): string {
  if (!value) return "—";
  if (value.includes("T")) return fmtDate(value);
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function etiquetaDocumento(row: ColaFiscalFila): string {
  if (row.tipo_comprobante === "NOTA_CREDITO") return "Nota de crédito";
  if (row.tipo_comprobante === "NOTA_DEBITO") return "Nota de débito";
  return "Factura";
}

function numeroFiscal(row: ColaFiscalFila): string {
  if (row.afip_punto_venta == null || row.afip_numero == null) return "Sin número fiscal";
  return `${String(row.afip_punto_venta).padStart(5, "0")}-${String(row.afip_numero).padStart(8, "0")}`;
}

function accionSegura(row: ColaFiscalFila, esAdmin: boolean): string {
  try {
    return presentarEstadoColaFiscal({
      estado: row.afip_estado,
      fase: row.afip_fase,
      claimVencido: row.claim_vencido,
      numeroFiscal: row.afip_numero,
      ventaAntigua: row.venta_antigua,
      legacyIncompleto: row.afip_legacy_incompleto,
      esAdmin,
    }).accion;
  } catch {
    return "Requiere administrador";
  }
}

function FilaSkeleton({ index }: { index: number }) {
  return (
    <TableRow key={index}>
      {[0, 1, 2, 3, 4, 5].map((cell) => (
        <TableCell key={cell}>
          <div className="h-4 animate-pulse rounded bg-muted" />
        </TableCell>
      ))}
    </TableRow>
  );
}

export function ColaFiscalTabla({
  filas,
  esAdmin,
  loading,
  updating,
  accionesHabilitadas,
  accionPendienteId,
  error,
  onRetry,
  onAccion,
}: {
  filas: ColaFiscalFila[];
  esAdmin: boolean;
  loading: boolean;
  updating: boolean;
  accionesHabilitadas: boolean;
  accionPendienteId?: string | null;
  error?: string | null;
  onRetry(): void;
  onAccion(row: ColaFiscalFila, accion: string, disparador: HTMLButtonElement): void;
}) {
  return (
    <section
      aria-labelledby="cola-tabla-titulo"
      aria-busy={!accionesHabilitadas || updating}
      className="rounded-xl border border-border bg-card shadow-card"
    >
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <div>
          <h2 id="cola-tabla-titulo" className="text-sm font-semibold">
            Comprobantes
          </h2>
          <p className="text-xs text-muted-foreground">
            Comprador, receptor y emisor por separado.
          </p>
        </div>
        <div aria-live="polite" className="text-xs text-muted-foreground">
          {updating ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Actualizando
            </span>
          ) : null}
        </div>
      </div>

      <Table className="min-w-[1080px]">
        <TableHeader>
          <TableRow>
            <TableHead>Documento</TableHead>
            <TableHead>Comprador → receptor</TableHead>
            <TableHead>Emisor y fechas</TableHead>
            <TableHead className="text-right">Importes</TableHead>
            <TableHead>Estado y validez</TableHead>
            <TableHead className="text-right">Acción</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? [0, 1, 2, 3, 4].map((index) => <FilaSkeleton key={index} index={index} />)
            : null}
          {!loading && error ? (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center">
                <p className="text-sm font-medium text-destructive">{error}</p>
                <Button className="mt-3 min-h-11" variant="outline" onClick={onRetry}>
                  Reintentar
                </Button>
              </TableCell>
            </TableRow>
          ) : null}
          {!loading && !error && filas.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-12 text-center">
                <FileSearch className="mx-auto h-7 w-7 text-muted-foreground/60" />
                <p className="mt-2 text-sm font-medium">No hay comprobantes en esta vista</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Probá otra pestaña o limpiá los filtros.
                </p>
              </TableCell>
            </TableRow>
          ) : null}
          {!loading && !error
            ? filas.map((row) => {
                const accion = accionSegura(row, esAdmin);
                const procesando = accion === "Procesando";
                const ejecutandoAccion = accionPendienteId === row.venta_id;
                const accionable = clasificarInteraccionCola(accion) !== null;
                return (
                  <TableRow key={row.venta_id}>
                    <TableCell className="align-top">
                      <div className="flex items-center gap-2 font-semibold">
                        <ReceiptText className="h-4 w-4 text-primary" />
                        {etiquetaDocumento(row)}
                      </div>
                      <p className="mt-1 font-mono text-xs">Venta V-{row.numero_comprobante}</p>
                      <p className="font-mono text-xs text-muted-foreground">{numeroFiscal(row)}</p>
                    </TableCell>
                    <TableCell className="align-top">
                      <p className="font-medium">{row.cliente_razon_social ?? "Sin comprador"}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.documento_comercial ?? "Sin documento comercial"}
                      </p>
                      <div className="my-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                        <ArrowRight className="h-3 w-3" /> Receptor fiscal
                      </div>
                      <p className="font-medium">{row.receptor_razon_social ?? "A confirmar"}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.receptor_tipo_documento
                          ? `${row.receptor_tipo_documento} ${row.receptor_numero_documento ?? ""}`
                          : "Todavía sin identidad congelada"}
                      </p>
                    </TableCell>
                    <TableCell className="align-top">
                      <p className="font-medium">
                        {row.emisor_razon_social ?? "Emisor a resolver"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.sucursal_nombre ?? "Sucursal a resolver"}
                      </p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-3 text-xs">
                        <div>
                          <dt className="text-muted-foreground">Comercial</dt>
                          <dd>{fecha(row.fecha_comercial)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Fiscal</dt>
                          <dd>{fecha(row.fecha_fiscal)}</dd>
                        </div>
                      </dl>
                    </TableCell>
                    <TableCell className="align-top text-right font-mono text-xs tabular-nums">
                      <p className="font-semibold">{fmtMoney(row.total)}</p>
                      <p className="text-success">Cobrado {fmtMoney(row.total_pagado)}</p>
                      <p className="text-muted-foreground">Saldo {fmtMoney(row.saldo)}</p>
                    </TableCell>
                    <TableCell className="align-top">
                      <EstadoFiscalPill estado={row.afip_estado} />
                      <p className="mt-2">
                        <ValidezFiscal validez={row.afip_validez} compacta />
                      </p>
                      {row.claim_vencido || row.venta_antigua ? (
                        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warning">
                          <AlertTriangle className="h-3 w-3" />
                          {row.claim_vencido ? "Claim vencido" : "Venta demorada"}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top text-right">
                      <Button
                        size="sm"
                        variant={accion === "Facturar" ? "default" : "outline"}
                        className="min-h-11 min-w-11"
                        disabled={!accionesHabilitadas || !accionable || accionPendienteId != null}
                        onClick={(event) => onAccion(row, accion, event.currentTarget)}
                      >
                        {procesando || ejecutandoAccion ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        {ejecutandoAccion ? "Procesando…" : accion}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            : null}
        </TableBody>
      </Table>
    </section>
  );
}
