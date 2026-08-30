import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, ReceiptText, Store } from "lucide-react";
import { ClientePicker } from "@/components/cliente-picker";
import {
  EditorPagos,
  type FormaPagoVenta,
  type PagoVentaEditable,
} from "@/components/ventas/editor-pagos";
import { ResumenCierreVenta } from "@/components/ventas/resumen-cierre-venta";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtDateTime, fmtMoney, formaPagoLabel } from "@/lib/format";
import { preflightConversionPresupuesto } from "@/lib/presupuestos.functions";
import {
  convertirPresupuestoEnVenta,
  type ConversionPresupuestoInput,
} from "@/lib/ventas.functions";

type PresupuestoConvertible = {
  id: string;
  total: number | string;
  cliente_id: string | null;
};

export type PresupuestoConvertido = {
  ventaId: string;
  clienteId: string;
  facturarAhora: boolean;
};

type ModoReceptor = "CONSUMIDOR_FINAL" | "IDENTIFICADO";

function modoInicial(clienteId: string | null): ModoReceptor {
  return clienteId ? "IDENTIFICADO" : "CONSUMIDOR_FINAL";
}

function mensajeErrorPreflight(): string {
  return "No se pudo confirmar la sucursal y su caja. Cerrá el diálogo y volvé a intentar.";
}

function esErrorAmbiguo(cause: unknown): boolean {
  const detalle = cause instanceof Error ? cause.message : "";
  return /failed to fetch|network|conexi|timeout|tiempo de espera/i.test(detalle);
}

function mensajeErrorConversion(cause: unknown): string {
  const detalle = cause instanceof Error ? cause.message : "";
  if (esErrorAmbiguo(cause)) {
    return "No se pudo confirmar si la venta se creó. Reintentá: se usará la misma operación y no se duplicará.";
  }
  if (/caja/i.test(detalle)) {
    return "La caja de esta sucursal ya no está abierta. Abrila y volvé a intentar.";
  }
  if (/presupuesto inexistente|sin acceso/i.test(detalle)) {
    return "No se pudo leer el presupuesto o no tenés acceso.";
  }
  if (/consumidor final|candidato|gen[eé]rico/i.test(detalle)) {
    return "No se pudo configurar Consumidor Final. Pedile a un administrador que revise el cliente genérico.";
  }
  if (/mantenimiento/i.test(detalle)) {
    return "La facturación está en mantenimiento. No se convirtió el presupuesto ni se registró ningún cobro.";
  }
  return "No se pudo convertir el presupuesto. Revisá los datos y volvé a intentar.";
}

function esMantenimiento(value: unknown): value is { estado: "MANTENIMIENTO"; mensaje: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).estado === "MANTENIMIENTO" &&
    typeof (value as Record<string, unknown>).mensaje === "string"
  );
}

export function DialogoConvertirPresupuesto({
  open,
  presupuesto,
  facturacionV2Habilitada,
  facturacionLegacyHabilitada,
  puedeFacturar,
  returnFocusRef,
  onOpenChange,
  onConvertida,
}: {
  open: boolean;
  presupuesto: PresupuestoConvertible;
  facturacionV2Habilitada: boolean;
  facturacionLegacyHabilitada: boolean;
  puedeFacturar: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onOpenChange(open: boolean): void;
  onConvertida(resultado: PresupuestoConvertido): void;
}) {
  const convertir = useServerFn(convertirPresupuestoEnVenta);
  const cargarPreflight = useServerFn(preflightConversionPresupuesto);
  const [receptor, setReceptor] = useState<ModoReceptor>(() => modoInicial(presupuesto.cliente_id));
  const [clienteId, setClienteId] = useState(presupuesto.cliente_id ?? "");
  const [tipoLegacy, setTipoLegacy] = useState<"FACTURA_A" | "FACTURA_B">("FACTURA_B");
  const [condicion, setCondicion] = useState<"CONTADO" | "CTA_CTE">("CONTADO");
  const [formaPagoLegacy, setFormaPagoLegacy] = useState<FormaPagoVenta>("EFECTIVO");
  const [pagos, setPagos] = useState<PagoVentaEditable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [intentoAmbiguo, setIntentoAmbiguo] = useState(false);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const entradaEstableRef = useRef<ConversionPresupuestoInput | null>(null);
  const facturarAhoraEstableRef = useRef<boolean | null>(null);
  const convirtiendoRef = useRef(false);
  const cicloRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cicloRef.current += 1;
    };
  }, []);

  useEffect(() => {
    cicloRef.current += 1;
    convirtiendoRef.current = false;
    entradaEstableRef.current = null;
    facturarAhoraEstableRef.current = null;
    if (!open) return;
    setReceptor(modoInicial(presupuesto.cliente_id));
    setClienteId(presupuesto.cliente_id ?? "");
    setTipoLegacy("FACTURA_B");
    setCondicion("CONTADO");
    setFormaPagoLegacy("EFECTIVO");
    setPagos([]);
    setError(null);
    setIntentoAmbiguo(false);
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [open, presupuesto.cliente_id, presupuesto.id]);

  const preflight = useQuery({
    queryKey: ["preflight-conversion-presupuesto", presupuesto.id],
    enabled: open,
    retry: false,
    queryFn: () => cargarPreflight({ data: { presupuesto_id: presupuesto.id } }),
  });

  const total = Number(presupuesto.total) || 0;
  const pagadoAhora = useMemo(
    () =>
      condicion === "CTA_CTE"
        ? 0
        : pagos.reduce((acumulado, pago) => acumulado + Number(pago.monto || 0), 0),
    [condicion, pagos],
  );
  const saldo = Math.round((total - pagadoAhora + Number.EPSILON) * 100) / 100;
  const mantenimiento = !facturacionV2Habilitada && !facturacionLegacyHabilitada;
  const preflightCargando = preflight.isPending || preflight.isFetching;
  const cajaConfirmada = !preflightCargando && !preflight.error && !!preflight.data?.caja;
  const receptorValido =
    receptor === "CONSUMIDOR_FINAL"
      ? facturacionV2Habilitada && !facturacionLegacyHabilitada
      : !!clienteId;
  const puedeConvertir =
    receptorValido &&
    cajaConfirmada &&
    !mantenimiento &&
    (condicion === "CTA_CTE" || facturacionLegacyHabilitada || pagadoAhora >= 0.01);

  const mutacion = useMutation({
    mutationFn: async (facturarAhora: boolean) => {
      const ciclo = cicloRef.current;
      let entrada = entradaEstableRef.current;
      if (!entrada) {
        if (receptor === "IDENTIFICADO" && !clienteId) throw new Error("Elegí el cliente.");
        const pagosRpc =
          condicion === "CTA_CTE"
            ? []
            : facturacionLegacyHabilitada
              ? [
                  {
                    forma_pago: formaPagoLegacy,
                    monto: total,
                    detalle: {},
                  },
                ]
              : pagos
                  .filter((pago) => Number(pago.monto || 0) > 0)
                  .map((pago) => ({
                    forma_pago: pago.forma_pago,
                    monto: Number(pago.monto),
                    detalle: pago.detalle,
                  }));
        entrada = facturacionLegacyHabilitada
          ? ({
              entrada: "LEGACY" as const,
              presupuesto_id: presupuesto.id,
              cliente_id: clienteId,
              tipo_comprobante: tipoLegacy,
              condicion_venta: condicion,
              pagos: pagosRpc,
              idempotency_key: idempotencyKeyRef.current,
            } as const)
          : ({
              entrada: "V2" as const,
              presupuesto_id: presupuesto.id,
              cliente_id: receptor === "CONSUMIDOR_FINAL" ? null : clienteId,
              condicion_venta: condicion,
              pagos: pagosRpc,
              idempotency_key: idempotencyKeyRef.current,
            } as const);
        entradaEstableRef.current = entrada;
        facturarAhoraEstableRef.current = facturarAhora;
      }
      const resultado = await convertir({ data: entrada });
      if (esMantenimiento(resultado)) throw new Error(resultado.mensaje);
      return {
        ciclo,
        conversion: {
          ventaId: resultado.id,
          clienteId: resultado.clienteId,
          facturarAhora:
            facturacionV2Habilitada &&
            puedeFacturar &&
            (facturarAhoraEstableRef.current ?? facturarAhora),
        },
      };
    },
    onMutate: () => setError(null),
    onSuccess: (resultado) => {
      if (!mountedRef.current || !open || resultado.ciclo !== cicloRef.current) return;
      onConvertida(resultado.conversion);
    },
    onError: (cause) => {
      if (esErrorAmbiguo(cause)) setIntentoAmbiguo(true);
      setError(mensajeErrorConversion(cause));
    },
    onSettled: () => {
      convirtiendoRef.current = false;
    },
  });

  const iniciarConversion = (facturarAhora: boolean) => {
    if (!puedeConvertir || mutacion.isPending || convirtiendoRef.current) return;
    convirtiendoRef.current = true;
    mutacion.mutate(facturarAhora);
  };

  const cambiarReceptor = (value: string) => {
    if (intentoAmbiguo) return;
    const next = value as ModoReceptor;
    setReceptor(next);
    entradaEstableRef.current = null;
    if (next === "CONSUMIDOR_FINAL") {
      setCondicion("CONTADO");
      setClienteId("");
    }
  };

  const controlesCongelados = mutacion.isPending || intentoAmbiguo;
  const deshabilitarConvertir =
    mutacion.isPending ||
    (intentoAmbiguo ? facturarAhoraEstableRef.current !== false : !puedeConvertir);
  const deshabilitarConvertirYFacturar =
    mutacion.isPending ||
    (intentoAmbiguo ? facturarAhoraEstableRef.current !== true : !puedeConvertir);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (controlesCongelados || convirtiendoRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-2xl p-0"
        closeDisabled={controlesCongelados}
        hideClose={controlesCongelados}
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <div className="px-4 pt-5 sm:px-6">
          <DialogHeader>
            <DialogTitle>Convertir en venta</DialogTitle>
            <DialogDescription>
              Revisá el cliente, la condición y el cobro antes de crear una única venta.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="max-h-[calc(100dvh-12rem)] space-y-4 overflow-y-auto px-4 sm:px-6">
          <p className="text-sm text-muted-foreground">
            Se crea una sola venta con los productos y precios congelados del presupuesto. Recién
            ahí se descuenta stock y se registra el cobro o la deuda.
          </p>

          {mantenimiento ? (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p>
                La facturación está en mantenimiento. No se convirtió el presupuesto ni se registró
                ningún cobro.
              </p>
            </div>
          ) : null}

          <fieldset disabled={controlesCongelados} className="contents">
            <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
              <Label>Receptor de la venta</Label>
              <RadioGroup
                value={receptor}
                disabled={controlesCongelados}
                onValueChange={cambiarReceptor}
                className="gap-3"
              >
                <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-background">
                  <RadioGroupItem
                    value="CONSUMIDOR_FINAL"
                    aria-label="Consumidor final / sin cliente"
                  />
                  <span>
                    <span className="block text-sm font-medium">
                      Consumidor final / sin cliente
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Venta de contado sin asociar el presupuesto a una ficha de cliente.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-background">
                  <RadioGroupItem value="IDENTIFICADO" aria-label="Cliente identificado" />
                  <span>
                    <span className="block text-sm font-medium">Cliente identificado</span>
                    <span className="block text-xs text-muted-foreground">
                      Elegí esta opción para usar una ficha o vender a cuenta corriente.
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {receptor === "IDENTIFICADO" ? (
              <div>
                <Label>Cliente *</Label>
                <ClientePicker
                  value={clienteId}
                  onChange={(value) => {
                    if (intentoAmbiguo) return;
                    setClienteId(value);
                    entradaEstableRef.current = null;
                  }}
                  testId="conv-cliente"
                  placeholder="Elegí…"
                />
              </div>
            ) : (
              <p className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">
                Cuenta corriente necesita un cliente identificado. Esta venta se crea de contado.
              </p>
            )}

            <div
              aria-live="polite"
              aria-atomic="true"
              className="flex items-start gap-3 rounded-xl border border-border p-3"
            >
              <Store className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="space-y-1 text-sm">
                <p>
                  Sucursal:{" "}
                  {preflightCargando
                    ? "Confirmando…"
                    : (preflight.data?.sucursalNombre ?? "Sin confirmar")}
                </p>
                <p>
                  {preflightCargando
                    ? "Confirmando caja abierta…"
                    : preflight.data?.caja
                      ? `Caja abierta desde ${fmtDateTime(preflight.data.caja.abiertaDesde)}`
                      : "No hay caja abierta"}
                </p>
                {!preflightCargando && preflight.data && !preflight.data.caja ? (
                  <p className="text-muted-foreground">
                    Abrí la caja de esta sucursal antes de convertir el presupuesto.
                  </p>
                ) : null}
              </div>
            </div>

            {preflight.error ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {mensajeErrorPreflight()}
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {facturacionLegacyHabilitada ? (
                <div>
                  <Label>Comprobante</Label>
                  <Select
                    value={tipoLegacy}
                    onValueChange={(value) => setTipoLegacy(value as typeof tipoLegacy)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="FACTURA_B">Factura B</SelectItem>
                      <SelectItem value="FACTURA_A">Factura A</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <Label>Comprobante</Label>
                  <div className="flex min-h-11 items-center rounded-md border border-input bg-muted/30 px-3 text-sm font-medium">
                    Venta · la letra se deriva al facturar
                  </div>
                </div>
              )}
              <div>
                <Label>Condición</Label>
                {receptor === "CONSUMIDOR_FINAL" ? (
                  <div className="flex min-h-11 items-center rounded-md border border-input bg-muted/30 px-3 text-sm font-medium">
                    Contado
                  </div>
                ) : (
                  <Select
                    value={condicion}
                    disabled={controlesCongelados}
                    onValueChange={(value) => {
                      if (intentoAmbiguo) return;
                      setCondicion(value as typeof condicion);
                      entradaEstableRef.current = null;
                      if (value === "CTA_CTE") setPagos([]);
                    }}
                  >
                    <SelectTrigger aria-label="Condición de venta">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CONTADO">Contado</SelectItem>
                      <SelectItem value="CTA_CTE">Cuenta corriente</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {condicion === "CONTADO" && facturacionLegacyHabilitada ? (
              <div>
                <Label>Cómo paga</Label>
                <Select
                  value={formaPagoLegacy}
                  onValueChange={(value) => setFormaPagoLegacy(value as FormaPagoVenta)}
                >
                  <SelectTrigger data-testid="conv-forma-pago">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      "EFECTIVO",
                      "TRANSFERENCIA",
                      "TARJETA_DEBITO",
                      "TARJETA_CREDITO",
                      "MERCADO_PAGO",
                      "CHEQUE",
                    ].map((forma) => (
                      <SelectItem key={forma} value={forma}>
                        {formaPagoLabel[forma] ?? forma}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {condicion === "CONTADO" && facturacionV2Habilitada ? (
              <EditorPagos
                pagos={pagos}
                saldo={saldo}
                disabled={controlesCongelados}
                onChange={(value) => {
                  if (intentoAmbiguo) return;
                  setPagos(value);
                }}
              />
            ) : null}

            <ResumenCierreVenta
              total={total}
              pagadoAhora={
                condicion === "CTA_CTE" ? 0 : facturacionLegacyHabilitada ? total : pagadoAhora
              }
              esCtaCte={condicion === "CTA_CTE"}
            />
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sticky bottom-0 border-t border-border bg-background px-4 pb-4 pt-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            disabled={controlesCongelados}
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          {facturacionV2Habilitada ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full sm:w-auto"
                data-testid="conv-confirmar"
                disabled={deshabilitarConvertir}
                onClick={() => iniciarConversion(false)}
              >
                {mutacion.isPending && mutacion.variables === false ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Convertir sin facturar
              </Button>
              {puedeFacturar ? (
                <Button
                  type="button"
                  className="min-h-11 w-full sm:w-auto"
                  data-testid="conv-y-facturar"
                  disabled={deshabilitarConvertirYFacturar}
                  onClick={() => iniciarConversion(true)}
                >
                  {mutacion.isPending && mutacion.variables === true ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ReceiptText className="h-4 w-4" />
                  )}
                  Convertir y facturar
                </Button>
              ) : null}
            </>
          ) : (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              data-testid="conv-confirmar"
              disabled={deshabilitarConvertir}
              onClick={() => iniciarConversion(false)}
            >
              {mutacion.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Crear la venta por {fmtMoney(total)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
