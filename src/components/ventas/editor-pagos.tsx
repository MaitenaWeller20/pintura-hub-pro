import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formaPagoLabel } from "@/lib/format";

export type FormaPagoVenta =
  | "EFECTIVO"
  | "TRANSFERENCIA"
  | "TARJETA_DEBITO"
  | "TARJETA_CREDITO"
  | "MERCADO_PAGO"
  | "CHEQUE";

export type PagoVentaEditable = {
  id: string;
  forma_pago: FormaPagoVenta;
  monto: number;
  detalle: Record<string, unknown>;
};

const FORMAS_PAGO = Object.entries(formaPagoLabel).filter(
  (entry): entry is [FormaPagoVenta, string] => entry[0] !== "CTA_CTE",
);

function textoDetalle(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function EditorPagos({
  pagos,
  saldo,
  disabled = false,
  emptyMessage = "Sin pagos. Al contado hay que cobrar algo, aunque sea una parte; si se lo lleva sin pagar nada, poné cuenta corriente.",
  onChange,
}: {
  pagos: PagoVentaEditable[];
  saldo: number;
  disabled?: boolean;
  emptyMessage?: string;
  onChange(pagos: PagoVentaEditable[]): void;
}) {
  const agregar = () =>
    onChange([
      ...pagos,
      {
        id: crypto.randomUUID(),
        forma_pago: "EFECTIVO",
        monto: Math.abs(Math.min(0, saldo)) || Math.max(0, saldo),
        detalle: {},
      },
    ]);

  const actualizar = (id: string, cambio: Partial<PagoVentaEditable>) =>
    onChange(pagos.map((pago) => (pago.id === id ? { ...pago, ...cambio } : pago)));

  const actualizarDetalle = (id: string, campo: string, value: string) =>
    onChange(
      pagos.map((pago) =>
        pago.id === id ? { ...pago, detalle: { ...pago.detalle, [campo]: value } } : pago,
      ),
    );

  return (
    <div className="space-y-3" data-testid="editor-pagos">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Formas de pago</h3>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={agregar}>
          <Plus className="mr-1 h-4 w-4" /> Agregar pago
        </Button>
      </div>

      {pagos.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="space-y-2">
          {pagos.map((pago) => {
            const formaId = `pago-forma-${pago.id}`;
            const montoId = `pago-monto-${pago.id}`;
            return (
              <div
                key={pago.id}
                className="grid grid-cols-1 items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-12"
              >
                <div className="sm:col-span-3">
                  <Label htmlFor={formaId} className="text-xs">
                    Forma
                  </Label>
                  <Select
                    value={pago.forma_pago}
                    disabled={disabled}
                    onValueChange={(value) =>
                      actualizar(pago.id, {
                        forma_pago: value as FormaPagoVenta,
                        detalle: {},
                      })
                    }
                  >
                    <SelectTrigger id={formaId} className="min-h-11 sm:h-9 sm:min-h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FORMAS_PAGO.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor={montoId} className="text-xs">
                    Monto
                  </Label>
                  <NumberInput
                    id={montoId}
                    className="min-h-11 sm:h-9 sm:min-h-9"
                    value={pago.monto}
                    disabled={disabled}
                    onValueChange={(value) => actualizar(pago.id, { monto: value ?? 0 })}
                  />
                </div>
                <div className="grid grid-cols-1 gap-2 sm:col-span-6 sm:grid-cols-2">
                  {pago.forma_pago === "TRANSFERENCIA" ? (
                    <div className="sm:col-span-2">
                      <Label htmlFor={`pago-banco-${pago.id}`} className="text-xs">
                        Banco / Cuenta
                      </Label>
                      <Input
                        id={`pago-banco-${pago.id}`}
                        className="min-h-11 sm:h-9 sm:min-h-9"
                        value={textoDetalle(pago.detalle.banco)}
                        disabled={disabled}
                        onChange={(event) =>
                          actualizarDetalle(pago.id, "banco", event.target.value)
                        }
                      />
                    </div>
                  ) : null}
                  {pago.forma_pago === "TARJETA_DEBITO" || pago.forma_pago === "TARJETA_CREDITO" ? (
                    <div className="sm:col-span-2">
                      <Label htmlFor={`pago-tarjeta-${pago.id}`} className="text-xs">
                        Tarjeta
                      </Label>
                      <Input
                        id={`pago-tarjeta-${pago.id}`}
                        className="min-h-11 sm:h-9 sm:min-h-9"
                        placeholder="Visa, Naranja…"
                        value={textoDetalle(pago.detalle.tarjeta)}
                        disabled={disabled}
                        onChange={(event) =>
                          actualizarDetalle(pago.id, "tarjeta", event.target.value)
                        }
                      />
                    </div>
                  ) : null}
                  {pago.forma_pago === "CHEQUE" ? (
                    <>
                      <div>
                        <Label htmlFor={`pago-cheque-banco-${pago.id}`} className="text-xs">
                          Banco
                        </Label>
                        <Input
                          id={`pago-cheque-banco-${pago.id}`}
                          className="min-h-11 sm:h-9 sm:min-h-9"
                          value={textoDetalle(pago.detalle.banco)}
                          disabled={disabled}
                          onChange={(event) =>
                            actualizarDetalle(pago.id, "banco", event.target.value)
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor={`pago-cheque-numero-${pago.id}`} className="text-xs">
                          Nro cheque
                        </Label>
                        <Input
                          id={`pago-cheque-numero-${pago.id}`}
                          className="min-h-11 sm:h-9 sm:min-h-9"
                          value={textoDetalle(pago.detalle.numero)}
                          disabled={disabled}
                          onChange={(event) =>
                            actualizarDetalle(pago.id, "numero", event.target.value)
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor={`pago-cheque-firmante-${pago.id}`} className="text-xs">
                          Firmante (Nombre y Apellido)
                        </Label>
                        <Input
                          id={`pago-cheque-firmante-${pago.id}`}
                          className="min-h-11 sm:h-9 sm:min-h-9"
                          value={textoDetalle(pago.detalle.firmante)}
                          disabled={disabled}
                          onChange={(event) =>
                            actualizarDetalle(pago.id, "firmante", event.target.value)
                          }
                        />
                      </div>
                      <div>
                        <Label htmlFor={`pago-cheque-fecha-${pago.id}`} className="text-xs">
                          Fecha cobro
                        </Label>
                        <Input
                          id={`pago-cheque-fecha-${pago.id}`}
                          type="date"
                          className="min-h-11 sm:h-9 sm:min-h-9"
                          value={textoDetalle(pago.detalle.fecha_cobro)}
                          disabled={disabled}
                          onChange={(event) =>
                            actualizarDetalle(pago.id, "fecha_cobro", event.target.value)
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="flex justify-end sm:col-span-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="min-h-11 min-w-11"
                    aria-label="Eliminar pago"
                    disabled={disabled}
                    onClick={() => onChange(pagos.filter((item) => item.id !== pago.id))}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
