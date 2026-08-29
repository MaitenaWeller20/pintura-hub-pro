import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { fmtMoney } from "@/lib/format";
import { ALICUOTAS_SOPORTADAS } from "@/lib/fiscal/codigos";
import {
  calcularTotalesNotaCreditoPeriodo,
  notaCreditoPeriodoInputSchema,
  validarLiquidacionNotaCreditoPeriodo,
  type FormaPagoReintegro,
  type ModalidadNcPeriodo,
  type NotaCreditoPeriodoInput,
  type ResolucionNcPeriodo,
} from "@/lib/fiscal/nota-credito-periodo";
import { camposVisiblesNcPeriodo, resumenEfectosNcPeriodo } from "@/lib/nota-credito-periodo-ui";

type ProductoDisponible = {
  id: string;
  descripcion: string;
  precioSinIva: number;
  ivaPorcentaje: number;
};

type ItemEditor = ProductoDisponible & { cantidad: number };
type PagoEditor = { id: string; formaPago: FormaPagoReintegro; monto: number | null };

const FORMAS_REINTEGRO: readonly FormaPagoReintegro[] = [
  "EFECTIVO",
  "TRANSFERENCIA",
  "TARJETA_DEBITO",
  "TARJETA_CREDITO",
  "MERCADO_PAGO",
  "CHEQUE",
];

const ETIQUETA_FORMA: Record<FormaPagoReintegro, string> = {
  EFECTIVO: "Efectivo",
  TRANSFERENCIA: "Transferencia",
  TARJETA_DEBITO: "Tarjeta de débito",
  TARJETA_CREDITO: "Tarjeta de crédito",
  MERCADO_PAGO: "Mercado Pago",
  CHEQUE: "Cheque",
};

function mensajeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Revisá los datos de la nota de crédito.";
}

export function EditorNotaCreditoPeriodo({
  sucursalId,
  clienteId,
  clienteComercial,
  productos,
  disabled = false,
  onCrear,
  onCancelar,
}: {
  sucursalId: string;
  clienteId: string;
  clienteComercial: string;
  productos: readonly ProductoDisponible[];
  disabled?: boolean;
  onCrear(input: NotaCreditoPeriodoInput): Promise<void>;
  onCancelar?(): void;
}) {
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [modalidad, setModalidad] = useState<ModalidadNcPeriodo>("DEVOLUCION_PRODUCTOS");
  const [resolucion, setResolucion] = useState<ResolucionNcPeriodo>("REINTEGRO");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [motivo, setMotivo] = useState("");
  const [items, setItems] = useState<ItemEditor[]>([]);
  const [productoAAgregar, setProductoAAgregar] = useState("");
  const [concepto, setConcepto] = useState("");
  const [importeConcepto, setImporteConcepto] = useState<number | null>(null);
  const [ivaConcepto, setIvaConcepto] = useState(21);
  const [pagos, setPagos] = useState<PagoEditor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);
  const visibles = camposVisiblesNcPeriodo(modalidad);

  const lineas =
    modalidad === "DEVOLUCION_PRODUCTOS"
      ? items.map((item) => ({
          cantidad: item.cantidad,
          precioUnitarioSinIva: item.precioSinIva,
          ivaPorcentaje: item.ivaPorcentaje,
        }))
      : importeConcepto && importeConcepto > 0
        ? [{ cantidad: 1, precioUnitarioSinIva: importeConcepto, ivaPorcentaje: ivaConcepto }]
        : [];
  const totales = (() => {
    try {
      return lineas.length > 0 ? calcularTotalesNotaCreditoPeriodo(lineas) : null;
    } catch {
      return null;
    }
  })();
  const pagosCentavos = pagos.flatMap((pago) =>
    pago.monto && pago.monto > 0
      ? [{ formaPago: pago.formaPago, montoCentavos: Math.round(pago.monto * 100) }]
      : [],
  );
  const resumen = resumenEfectosNcPeriodo({
    modalidad,
    resolucion,
    items:
      modalidad === "DEVOLUCION_PRODUCTOS"
        ? items.map(({ descripcion, cantidad }) => ({ descripcion, cantidad }))
        : [{ descripcion: concepto || "Concepto a confirmar", cantidad: 1 }],
    pagos: pagosCentavos,
    totalCentavos: totales?.totalCentavos ?? 0,
    clienteComercial,
    receptorFiscal: "A confirmar en la revisión fiscal",
  });

  const cambiarModalidad = (siguiente: ModalidadNcPeriodo) => {
    setModalidad(siguiente);
    setItems([]);
    setConcepto("");
    setImporteConcepto(null);
    setError(null);
  };

  const cambiarResolucion = (siguiente: ResolucionNcPeriodo) => {
    setResolucion(siguiente);
    if (siguiente === "SALDO_FAVOR") setPagos([]);
    setError(null);
  };

  const restablecer = () => {
    setIdempotencyKey(crypto.randomUUID());
    setDesde("");
    setHasta("");
    setMotivo("");
    setItems([]);
    setConcepto("");
    setImporteConcepto(null);
    setPagos([]);
    setError(null);
  };

  const crear = async () => {
    if (creando || disabled) return;
    if (!motivo.trim()) {
      setError("Indicá el motivo de la nota de crédito.");
      return;
    }
    if (!totales) {
      setError("Cargá un importe positivo para la nota de crédito.");
      return;
    }
    try {
      validarLiquidacionNotaCreditoPeriodo({
        resolucion,
        totalCentavos: totales.totalCentavos,
        pagos: pagosCentavos,
        clienteId,
      });
      const input =
        modalidad === "DEVOLUCION_PRODUCTOS"
          ? {
              idempotency_key: idempotencyKey,
              sucursal_id: sucursalId,
              cliente_id: clienteId,
              periodo_desde: desde,
              periodo_hasta: hasta,
              motivo,
              modalidad,
              resolucion,
              pagos: pagosCentavos.map((pago) => ({
                forma_pago: pago.formaPago,
                monto_centavos: pago.montoCentavos,
              })),
              items: items.map((item) => ({
                producto_id: item.id,
                cantidad: item.cantidad,
                precio_unitario_sin_iva: item.precioSinIva,
                iva_porcentaje: item.ivaPorcentaje,
              })),
            }
          : {
              idempotency_key: idempotencyKey,
              sucursal_id: sucursalId,
              cliente_id: clienteId,
              periodo_desde: desde,
              periodo_hasta: hasta,
              motivo,
              modalidad,
              resolucion,
              pagos: pagosCentavos.map((pago) => ({
                forma_pago: pago.formaPago,
                monto_centavos: pago.montoCentavos,
              })),
              items: [
                {
                  producto_id: null,
                  descripcion: concepto,
                  cantidad: 1,
                  precio_unitario_sin_iva: importeConcepto ?? 0,
                  iva_porcentaje: ivaConcepto,
                },
              ] as const,
            };
      const valido = notaCreditoPeriodoInputSchema.parse(input);
      setCreando(true);
      setError(null);
      await onCrear(valido);
      restablecer();
    } catch (cause) {
      setError(mensajeError(cause));
    } finally {
      setCreando(false);
    }
  };

  return (
    <section aria-labelledby="nc-periodo-titulo" className="space-y-4">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
        <h2 id="nc-periodo-titulo" className="text-sm font-semibold">
          Asociación fiscal por período
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Prepará la nota pendiente. La letra y el receptor fiscal se confirman después, en la cola.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="nc-periodo-desde">Desde</Label>
          <Input
            id="nc-periodo-desde"
            type="date"
            value={desde}
            disabled={disabled || creando}
            aria-describedby={error ? "nc-periodo-error" : undefined}
            onChange={(event) => setDesde(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="nc-periodo-hasta">Hasta</Label>
          <Input
            id="nc-periodo-hasta"
            type="date"
            value={hasta}
            disabled={disabled || creando}
            aria-describedby={error ? "nc-periodo-error" : undefined}
            onChange={(event) => setHasta(event.target.value)}
          />
        </div>
      </div>

      <div>
        <Label htmlFor="nc-periodo-motivo">Motivo</Label>
        <Textarea
          id="nc-periodo-motivo"
          value={motivo}
          disabled={disabled || creando}
          onChange={(event) => setMotivo(event.target.value)}
          aria-describedby={error ? "nc-periodo-error" : undefined}
        />
      </div>

      <fieldset disabled={disabled || creando} className="space-y-2">
        <legend className="text-sm font-semibold">Modalidad</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
            <input
              type="radio"
              name="nc-modalidad"
              checked={modalidad === "DEVOLUCION_PRODUCTOS"}
              onChange={() => cambiarModalidad("DEVOLUCION_PRODUCTOS")}
            />
            Devolución de productos
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
            <input
              type="radio"
              name="nc-modalidad"
              checked={modalidad === "BONIFICACION_AJUSTE"}
              onChange={() => cambiarModalidad("BONIFICACION_AJUSTE")}
            />
            Bonificación o ajuste
          </label>
        </div>
      </fieldset>

      {visibles.productos ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <Label htmlFor="nc-producto">Producto a devolver</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={productoAAgregar} onValueChange={setProductoAAgregar}>
              <SelectTrigger id="nc-producto">
                <SelectValue placeholder="Seleccionar producto…" />
              </SelectTrigger>
              <SelectContent>
                {productos.map((producto) => (
                  <SelectItem key={producto.id} value={producto.id}>
                    {producto.descripcion}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={!productoAAgregar}
              onClick={() => {
                const producto = productos.find((item) => item.id === productoAAgregar);
                if (!producto) return;
                setItems((actual) => [...actual, { ...producto, cantidad: 1 }]);
                setProductoAAgregar("");
              }}
            >
              <Plus /> Agregar
            </Button>
          </div>
          {items.map((item, index) => (
            <div key={`${item.id}-${index}`} className="flex items-end gap-2 text-sm">
              <p className="min-w-0 flex-1 truncate">{item.descripcion}</p>
              <div className="w-24">
                <Label htmlFor={`nc-cantidad-${index}`} className="text-xs">
                  Cantidad
                </Label>
                <NumberInput
                  id={`nc-cantidad-${index}`}
                  value={item.cantidad}
                  onValueChange={(cantidad) =>
                    setItems((actual) =>
                      actual.map((linea, lineaIndex) =>
                        lineaIndex === index ? { ...linea, cantidad: cantidad ?? 0 } : linea,
                      ),
                    )
                  }
                />
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Quitar ${item.descripcion}`}
                onClick={() =>
                  setItems((actual) => actual.filter((_, lineaIndex) => lineaIndex !== index))
                }
              >
                <Trash2 className="text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {visibles.concepto ? (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <Label htmlFor="nc-concepto">Concepto del ajuste</Label>
            <Input
              id="nc-concepto"
              value={concepto}
              onChange={(event) => setConcepto(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="nc-importe">Importe neto</Label>
            <NumberInput
              id="nc-importe"
              value={importeConcepto}
              onValueChange={setImporteConcepto}
            />
          </div>
          <div>
            <Label htmlFor="nc-iva">IVA</Label>
            <Select
              value={String(ivaConcepto)}
              onValueChange={(value) => setIvaConcepto(Number(value))}
            >
              <SelectTrigger id="nc-iva">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALICUOTAS_SOPORTADAS.map((alicuota) => (
                  <SelectItem key={alicuota} value={String(alicuota)}>
                    {String(alicuota).replace(".", ",")}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <fieldset disabled={disabled || creando} className="space-y-2">
        <legend className="text-sm font-semibold">Resolución</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
            <input
              type="radio"
              name="nc-resolucion"
              checked={resolucion === "REINTEGRO"}
              onChange={() => cambiarResolucion("REINTEGRO")}
            />{" "}
            Reintegrar el importe
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 focus-within:ring-2 focus-within:ring-ring">
            <input
              type="radio"
              name="nc-resolucion"
              checked={resolucion === "SALDO_FAVOR"}
              onChange={() => cambiarResolucion("SALDO_FAVOR")}
            />{" "}
            Acreditar saldo a favor
          </label>
        </div>
      </fieldset>

      {resolucion === "REINTEGRO" ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Reintegro exacto</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setPagos((actual) => [
                  ...actual,
                  {
                    id: crypto.randomUUID(),
                    formaPago: "EFECTIVO",
                    monto: (totales?.totalCentavos ?? 0) / 100,
                  },
                ])
              }
            >
              <Plus /> Agregar medio
            </Button>
          </div>
          {pagos.map((pago, index) => (
            <div key={pago.id} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
              <Select
                value={pago.formaPago}
                onValueChange={(formaPago) =>
                  setPagos((actual) =>
                    actual.map((item) =>
                      item.id === pago.id
                        ? { ...item, formaPago: formaPago as FormaPagoReintegro }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger aria-label={`Forma de reintegro ${index + 1}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMAS_REINTEGRO.map((forma) => (
                    <SelectItem key={forma} value={forma}>
                      {ETIQUETA_FORMA[forma]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <NumberInput
                aria-label={`Monto de reintegro ${index + 1}`}
                value={pago.monto}
                onValueChange={(monto) =>
                  setPagos((actual) =>
                    actual.map((item) => (item.id === pago.id ? { ...item, monto } : item)),
                  )
                }
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Quitar reintegro"
                onClick={() => setPagos((actual) => actual.filter((item) => item.id !== pago.id))}
              >
                <Trash2 className="text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <section
        aria-label="Efectos después de emitir"
        className="rounded-xl border border-border bg-muted/20 p-4 text-sm"
      >
        <p className="font-semibold">Efectos estimados</p>
        <p className="mt-1 text-muted-foreground">{resumen.stock}</p>
        {resumen.liquidacion.map((linea) => (
          <p key={linea} className="mt-1 text-muted-foreground">
            {linea}
          </p>
        ))}
        {resumen.advertenciaTitular ? (
          <p className="mt-2 font-medium text-warning">{resumen.advertenciaTitular}</p>
        ) : null}
        <dl className="mt-3 grid gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">Neto estimado</dt>
            <dd className="font-mono">{fmtMoney((totales?.netoCentavos ?? 0) / 100)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">IVA estimado</dt>
            <dd className="font-mono">{fmtMoney((totales?.ivaCentavos ?? 0) / 100)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Total estimado</dt>
            <dd className="font-mono font-semibold">
              {fmtMoney((totales?.totalCentavos ?? 0) / 100)}
            </dd>
          </div>
        </dl>
      </section>

      {error ? (
        <p id="nc-periodo-error" role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancelar ? (
          <Button
            type="button"
            variant="outline"
            disabled={creando}
            onClick={() => {
              restablecer();
              onCancelar();
            }}
          >
            Cancelar
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={disabled || creando || !sucursalId || !clienteId}
          onClick={() => void crear()}
        >
          {creando ? "Creando…" : "Crear nota pendiente"}
        </Button>
      </div>
    </section>
  );
}
