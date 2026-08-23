import { useState, type RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Printer } from "lucide-react";
import { toast } from "sonner";

import { DataTable } from "@/components/app/data-table";
import { EstadoFiscalPill } from "@/components/fiscal/estado-fiscal-pill";
import { ValidezFiscal } from "@/components/fiscal/validez-fiscal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TableCell, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import { fmtDocumento } from "@/lib/documento";
import { datosFiscalesComprobante } from "@/lib/fiscal.functions";
import { CBTE_INFO } from "@/lib/fiscal/codigos";
import {
  generarComprobantePdf,
  numeroFiscal,
  type VentaImpresa,
} from "@/lib/fiscal/comprobante-pdf";
import type { DatosFiscalesPreparados } from "@/lib/fiscal/impresion";
import { fmtDateTime, fmtMoney, formaPagoLabel, tipoComprobanteLabel } from "@/lib/format";
import { leerComprobanteAsociadoFiscal, leerReceptorFiscalCongelado } from "@/lib/ventas-ui";

import { prepararDescargaVenta } from "./preparar-descarga-venta";
import { cargarDetalleVentaCompleto } from "./detalle-venta";

type VentaRow = Database["public"]["Tables"]["ventas"]["Row"];
type ItemVenta = Database["public"]["Tables"]["venta_items"]["Row"];
type PagoVenta = Database["public"]["Tables"]["venta_pagos"]["Row"];

export type VentaDetalle = VentaRow & {
  cliente?: { razon_social: string | null; cuit_dni: string | null } | null;
  sucursal?: { nombre: string | null; telefono?: string | null } | null;
};

function esRegistro(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descripcionFiscal(venta: VentaDetalle): string | null {
  if (!venta.afip_punto_venta || !venta.afip_numero || !venta.afip_cbte_tipo) return null;
  const info = CBTE_INFO[venta.afip_cbte_tipo];
  if (!info) return null;
  const clase = [1, 6, 11].includes(venta.afip_cbte_tipo)
    ? "Factura"
    : [3, 8, 13].includes(venta.afip_cbte_tipo)
      ? "Nota de crédito"
      : [2, 7, 12].includes(venta.afip_cbte_tipo)
        ? "Nota de débito"
        : "Comprobante";
  return `${clase} ${info.letra} ${numeroFiscal(venta.afip_punto_venta, venta.afip_numero)}`;
}

function detallePago(detalle: Json): string | null {
  if (!esRegistro(detalle)) return null;
  const valores = Object.values(detalle)
    .filter(
      (value): value is string | number => typeof value === "string" || typeof value === "number",
    )
    .map(String)
    .filter(Boolean);
  return valores.length ? valores.join(", ") : null;
}

export function DialogoDetalleVenta({
  venta,
  onClose,
  permitirDescarga = true,
  returnFocusRef,
}: {
  venta: VentaDetalle | null;
  onClose(): void;
  permitirDescarga?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [imprimiendo, setImprimiendo] = useState(false);
  const detalleQuery = useQuery({
    queryKey: ["venta-detail", venta?.id],
    enabled: !!venta,
    queryFn: async () => {
      if (!venta) throw new Error("No hay una venta seleccionada para cargar el detalle.");
      return cargarDetalleVentaCompleto<ItemVenta, PagoVenta>({
        cargarItems: async () => {
          const { data, error } = await supabase
            .from("venta_items")
            .select("*")
            .eq("venta_id", venta.id);
          return { data, error };
        },
        cargarPagos: async () => {
          const { data, error } = await supabase
            .from("venta_pagos")
            .select("*")
            .eq("venta_id", venta.id);
          return { data, error };
        },
      });
    },
  });
  const detalle = detalleQuery.data;
  const datosFiscalesFn = useServerFn(datosFiscalesComprobante);

  const imprimir = async () => {
    if (!venta || !detalle || imprimiendo) return;
    setImprimiendo(true);
    try {
      const resultado = await prepararDescargaVenta<
        VentaDetalle,
        ItemVenta,
        DatosFiscalesPreparados,
        ReturnType<typeof generarComprobantePdf>
      >(
        {
          venta,
          items: detalle.items,
        },
        {
          cargarFiscal: async () => {
            const fiscal = await datosFiscalesFn({ data: { venta_id: venta.id } });
            if (!fiscal) throw new Error("No se pudieron leer los datos fiscales autorizados.");
            return fiscal;
          },
          generar: (ventaParaPdf, items, fiscal) =>
            generarComprobantePdf(ventaParaPdf as VentaImpresa, items, fiscal),
        },
      );
      resultado.doc.save(resultado.nombre);
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : "No se pudo preparar el PDF fiscal.";
      toast.error(mensaje, { duration: 12000 });
    } finally {
      setImprimiendo(false);
    }
  };

  const receptor = venta ? leerReceptorFiscalCongelado(venta.afip_snapshot) : null;
  const comprobanteAsociado = venta ? leerComprobanteAsociadoFiscal(venta.afip_snapshot) : null;
  const fiscal = venta ? descripcionFiscal(venta) : null;

  return (
    <Dialog open={!!venta} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] max-w-3xl sm:max-h-[calc(100dvh-2rem)]"
        data-testid="dialogo-detalle-venta"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        {venta ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between">
                <span>Venta {venta.numero_comprobante}</span>
                {permitirDescarga ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={imprimir}
                    disabled={
                      imprimiendo ||
                      detalleQuery.isPending ||
                      detalleQuery.isFetching ||
                      !!detalleQuery.error ||
                      !detalle
                    }
                    className="min-h-11 sm:min-h-9"
                  >
                    {imprimiendo ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Printer className="mr-1 h-4 w-4" />
                    )}
                    PDF
                  </Button>
                ) : null}
              </DialogTitle>
              <DialogDescription>
                Detalle comercial, pagos y estado fiscal de la venta seleccionada.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <strong>Fecha comercial:</strong> {fmtDateTime(venta.fecha)}
              </div>
              <div>
                <strong>Sucursal:</strong> {venta.sucursal?.nombre}
              </div>
              <div>
                <strong>Comprador:</strong> {venta.cliente?.razon_social}
                <br />
                <span className="text-xs text-muted-foreground">
                  {fmtDocumento(venta.cliente?.cuit_dni)}
                </span>
              </div>
              <div className="space-y-1">
                <strong>Estado fiscal:</strong> <EstadoFiscalPill estado={venta.afip_estado} />
                <div className="mt-1">
                  <ValidezFiscal validez={venta.afip_validez} estado={venta.afip_estado} compacta />
                </div>
                {fiscal ? <p className="font-medium">{fiscal}</p> : null}
                {venta.afip_fecha_comprobante ? (
                  <p className="text-xs text-muted-foreground">
                    Fecha fiscal: {venta.afip_fecha_comprobante.split("-").reverse().join("/")}
                  </p>
                ) : null}
              </div>
              {receptor ? (
                <div className="rounded-md border border-border bg-muted/30 p-3 sm:col-span-2">
                  <strong>Receptor fiscal de la emisión:</strong> {receptor.razonSocial}
                  <p className="text-xs text-muted-foreground">
                    {[receptor.tipoDocumento, receptor.numeroDocumento, receptor.condicionIva]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Domicilio fiscal: {receptor.domicilio ?? "no informado"}
                  </p>
                </div>
              ) : null}
              {comprobanteAsociado ? (
                <div className="rounded-md border border-border bg-muted/30 p-3 sm:col-span-2">
                  <strong>Comprobante fiscal asociado:</strong> {comprobanteAsociado.titulo}{" "}
                  {comprobanteAsociado.letra}
                  <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-muted-foreground">CbteTipo</dt>
                      <dd className="font-mono">{comprobanteAsociado.tipo}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Punto de venta</dt>
                      <dd className="font-mono">
                        {String(comprobanteAsociado.puntoVenta).padStart(5, "0")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Número</dt>
                      <dd className="font-mono">
                        {String(comprobanteAsociado.numero).padStart(8, "0")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Fecha</dt>
                      <dd>{comprobanteAsociado.fecha.split("-").reverse().join("/")}</dd>
                    </div>
                  </dl>
                  <p className="mt-2 text-xs text-muted-foreground">
                    CUIT emisor {comprobanteAsociado.cuit}. La nota conserva esta referencia y el
                    receptor fiscal del original; no se pueden editar.
                  </p>
                </div>
              ) : (venta.tipo_comprobante === "NOTA_CREDITO" ||
                  venta.tipo_comprobante === "NOTA_DEBITO") &&
                venta.afip_cbte_asoc_id ? (
                <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm sm:col-span-2">
                  La asociación fiscal exacta se congela y se muestra al emitir la nota.
                </div>
              ) : null}
            </div>

            {detalleQuery.isPending ? (
              <div className="flex min-h-24 items-center justify-center gap-2" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span className="text-sm text-muted-foreground">Cargando detalle completo…</span>
              </div>
            ) : detalleQuery.error ? (
              <div
                className="space-y-3 rounded-lg border border-destructive/35 bg-destructive/5 p-4"
                role="alert"
                data-testid="error-detalle-venta"
              >
                <p className="text-sm font-medium text-destructive">
                  {detalleQuery.error instanceof Error
                    ? detalleQuery.error.message
                    : "No se pudo cargar el detalle completo de la venta."}
                </p>
                <p className="text-xs text-muted-foreground">
                  La descarga permanece deshabilitada hasta recuperar ítems y pagos.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 min-w-11"
                    onClick={() => void detalleQuery.refetch()}
                    disabled={detalleQuery.isFetching}
                  >
                    {detalleQuery.isFetching ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    Reintentar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 min-w-11"
                    onClick={onClose}
                  >
                    Cerrar
                  </Button>
                </div>
              </div>
            ) : detalle ? (
              <>
                <div className="mt-2">
                  <DataTable columns={["Cód.", "Descripción", "Cant.", "P. unit.", "Subtotal"]}>
                    {detalle.items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-mono text-xs">{item.codigo}</TableCell>
                        <TableCell>{item.descripcion}</TableCell>
                        <TableCell className="text-right">{item.cantidad}</TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtMoney(item.precio_unitario_sin_iva)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmtMoney(item.subtotal_con_iva)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </DataTable>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Card className="p-3">
                    <h4 className="mb-2 text-sm font-semibold">Pagos</h4>
                    {venta.condicion_venta === "CTA_CTE" ? (
                      <p className="text-xs text-muted-foreground">
                        Venta a cuenta corriente. Los cobros se registran en{" "}
                        <Link to="/cuentas-corrientes" className="text-primary underline">
                          Cuentas Corrientes
                        </Link>
                        .
                      </p>
                    ) : detalle.pagos.length === 0 ? (
                      <p className="text-xs text-muted-foreground">Sin pagos registrados.</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {detalle.pagos.map((pago) => {
                          const descripcion = detallePago(pago.detalle);
                          return (
                            <li key={pago.id} className="flex justify-between gap-3">
                              <span>
                                {formaPagoLabel[pago.forma_pago]}
                                {descripcion ? ` (${descripcion})` : ""}
                              </span>
                              <span className="font-mono">{fmtMoney(pago.monto)}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                  <Card className="p-3">
                    <h4 className="mb-2 text-sm font-semibold">Totales</h4>
                    <ul className="space-y-1 text-sm">
                      <li className="flex justify-between">
                        <span>Subtotal:</span>
                        <span className="font-mono">{fmtMoney(venta.subtotal_sin_iva)}</span>
                      </li>
                      <li className="flex justify-between">
                        <span>IVA:</span>
                        <span className="font-mono">{fmtMoney(venta.iva_total)}</span>
                      </li>
                      <li className="flex justify-between">
                        <span>Percepciones:</span>
                        <span className="font-mono">{fmtMoney(venta.percepciones)}</span>
                      </li>
                      <li className="mt-1 flex justify-between border-t border-border pt-1 font-bold">
                        <span>TOTAL:</span>
                        <span className="font-mono">{fmtMoney(venta.total)}</span>
                      </li>
                      {venta.condicion_venta === "CTA_CTE" ? (
                        <li className="flex justify-between text-warning">
                          <span>Condición:</span>
                          <span>A cuenta corriente</span>
                        </li>
                      ) : (
                        <>
                          <li className="flex justify-between text-success">
                            <span>Pagado:</span>
                            <span className="font-mono">{fmtMoney(venta.total_pagado)}</span>
                          </li>
                          {Number(venta.total) - Number(venta.total_pagado) > 0.01 ? (
                            <li className="flex justify-between text-destructive">
                              <span>Pendiente:</span>
                              <span className="font-mono">
                                {fmtMoney(Number(venta.total) - Number(venta.total_pagado))}
                              </span>
                            </li>
                          ) : null}
                        </>
                      )}
                    </ul>
                  </Card>
                </div>
              </>
            ) : null}
            {venta.observaciones ? (
              <p className="mt-2 text-xs text-muted-foreground">
                <strong>Obs:</strong> {venta.observaciones}
              </p>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
