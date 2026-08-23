import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, ReceiptText } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fmtMoney, formaPagoLabel } from "@/lib/format";
import { convertirPresupuestoEnVenta } from "@/lib/ventas.functions";

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
  const [clienteId, setClienteId] = useState(presupuesto.cliente_id ?? "");
  const [tipoLegacy, setTipoLegacy] = useState<"FACTURA_A" | "FACTURA_B">("FACTURA_B");
  const [condicion, setCondicion] = useState<"CONTADO" | "CTA_CTE">("CONTADO");
  const [formaPagoLegacy, setFormaPagoLegacy] = useState<FormaPagoVenta>("EFECTIVO");
  const [pagos, setPagos] = useState<PagoVentaEditable[]>([]);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const convirtiendoRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setClienteId(presupuesto.cliente_id ?? "");
    setTipoLegacy("FACTURA_B");
    setCondicion("CONTADO");
    setFormaPagoLegacy("EFECTIVO");
    setPagos([]);
    setError(null);
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [open, presupuesto.cliente_id, presupuesto.id]);

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
  const puedeConvertir =
    !!clienteId &&
    !mantenimiento &&
    (condicion === "CTA_CTE" || facturacionLegacyHabilitada || pagadoAhora >= 0.01);

  const mutacion = useMutation({
    mutationFn: async (facturarAhora: boolean) => {
      if (convirtiendoRef.current) throw new Error("La conversión ya está en curso.");
      if (!clienteId) throw new Error("Elegí el cliente.");
      convirtiendoRef.current = true;
      try {
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
        const entrada = facturacionLegacyHabilitada
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
              cliente_id: clienteId,
              condicion_venta: condicion,
              pagos: pagosRpc,
              idempotency_key: idempotencyKeyRef.current,
            } as const);
        const resultado = await convertir({ data: entrada });
        if (esMantenimiento(resultado)) throw new Error(resultado.mensaje);
        return {
          ventaId: resultado.id,
          clienteId,
          facturarAhora: facturacionV2Habilitada && puedeFacturar && facturarAhora,
        };
      } finally {
        convirtiendoRef.current = false;
      }
    },
    onMutate: () => setError(null),
    onSuccess: onConvertida,
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : "No se pudo convertir el presupuesto."),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (mutacion.isPending || convirtiendoRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-w-2xl p-0"
        closeDisabled={mutacion.isPending}
        hideClose={mutacion.isPending}
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

          <div>
            <Label>Cliente *</Label>
            <ClientePicker
              value={clienteId}
              onChange={setClienteId}
              testId="conv-cliente"
              placeholder="Elegí…"
            />
          </div>

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
              <Select
                value={condicion}
                onValueChange={(value) => {
                  setCondicion(value as typeof condicion);
                  if (value === "CTA_CTE") setPagos([]);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CONTADO">Contado</SelectItem>
                  <SelectItem value="CTA_CTE">Cuenta corriente</SelectItem>
                </SelectContent>
              </Select>
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
              disabled={mutacion.isPending}
              onChange={setPagos}
            />
          ) : null}

          <ResumenCierreVenta
            total={total}
            pagadoAhora={
              condicion === "CTA_CTE" ? 0 : facturacionLegacyHabilitada ? total : pagadoAhora
            }
            esCtaCte={condicion === "CTA_CTE"}
          />

          <div aria-live="polite" aria-atomic="true">
            {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
          </div>
        </div>

        <DialogFooter className="sticky bottom-0 border-t border-border bg-background px-4 pb-4 pt-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            disabled={mutacion.isPending}
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
                disabled={!puedeConvertir || mutacion.isPending}
                onClick={() => mutacion.mutate(false)}
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
                  disabled={!puedeConvertir || mutacion.isPending}
                  onClick={() => mutacion.mutate(true)}
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
              disabled={!puedeConvertir || mutacion.isPending}
              onClick={() => mutacion.mutate(false)}
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
