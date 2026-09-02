import type { RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { ReceptorFiscalConfirmado, TipoDocumentoFiscal } from "@/lib/fiscal/receptor";
import type { CondicionIva } from "@/lib/fiscal/codigos";
import { adaptarReceptorFormularioALetra, type LetraSolicitada } from "./dialogo-emision-state";
import type { CampoReceptorFiscal } from "./dialogo-emision-validacion";
import { type ClaveConsultaPadron, type EstadoConsultaPadronUi } from "./padron-receptor";

export type ReceptorFormulario =
  | { origen: "CLIENTE_COMERCIAL" }
  | { origen: "FAVORITO"; receptor_fiscal_id: string }
  | {
      origen: "MANUAL";
      tipo_documento: TipoDocumentoFiscal;
      numero_documento: string;
      razon_social: string;
      condicion_iva: CondicionIva;
      domicilio: string;
      guardar_para_proximas: boolean;
    }
  | { origen: "COMPROBANTE_ORIGINAL" };

export type ReceptorHeredadoVista = Pick<
  ReceptorFiscalConfirmado,
  "razonSocial" | "tipoDocumento" | "numeroDocumento" | "condicionIva" | "domicilio"
>;

type ReceptorManual = Extract<ReceptorFormulario, { origen: "MANUAL" }>;

const CONDICIONES_POR_LETRA: Record<
  LetraSolicitada,
  ReadonlyArray<{ value: CondicionIva; label: string }>
> = {
  A: [
    { value: "RESPONSABLE_INSCRIPTO", label: "Responsable inscripto" },
    { value: "MONOTRIBUTO", label: "Monotributo" },
  ],
  B: [
    { value: "CONSUMIDOR_FINAL", label: "Consumidor final" },
    { value: "EXENTO", label: "Exento" },
  ],
};

const TODAS_LAS_CONDICIONES: ReadonlyArray<{ value: CondicionIva; label: string }> = [
  { value: "RESPONSABLE_INSCRIPTO", label: "Responsable inscripto" },
  { value: "MONOTRIBUTO", label: "Monotributo" },
  { value: "EXENTO", label: "Exento" },
  { value: "CONSUMIDOR_FINAL", label: "Consumidor final" },
];

const ETIQUETA_CONDICION_IVA: Record<CondicionIva, string> = {
  RESPONSABLE_INSCRIPTO: "Responsable inscripto",
  MONOTRIBUTO: "Monotributo",
  EXENTO: "Exento",
  CONSUMIDOR_FINAL: "Consumidor final",
};

function crearReceptorManualVacio(letraSolicitada: LetraSolicitada | null): ReceptorManual {
  return {
    origen: "MANUAL",
    tipo_documento: letraSolicitada === "B" ? "SIN_IDENTIFICAR" : "CUIT",
    numero_documento: "",
    razon_social: "",
    condicion_iva: letraSolicitada === "B" ? "CONSUMIDOR_FINAL" : "RESPONSABLE_INSCRIPTO",
    domicilio: "",
    guardar_para_proximas: false,
  };
}

function DocumentoReceptor({ receptor }: { receptor: ReceptorHeredadoVista }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <p className="font-semibold">{receptor.razonSocial}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {receptor.tipoDocumento} {receptor.numeroDocumento ?? "sin identificar"} ·{" "}
        {receptor.condicionIva}
      </p>
      {receptor.domicilio ? (
        <p className="mt-1 text-xs text-muted-foreground">{receptor.domicilio}</p>
      ) : null}
    </div>
  );
}

function horaPadron(fecha: string): string {
  return new Intl.DateTimeFormat("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(fecha));
}

function EstadoPadron({
  estado,
  claveActual,
}: {
  estado: EstadoConsultaPadronUi;
  claveActual: ClaveConsultaPadron | null;
}) {
  if (!claveActual || estado.estado === "INACTIVO") return null;
  if (estado.estado === "VERIFICADO" && estado.receptor.cuit === claveActual.cuit) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm sm:col-span-2"
      >
        <strong className="block text-primary">CUIT verificado por ARCA</strong>
        <span className="text-xs text-muted-foreground">
          Verificado a las{" "}
          <time dateTime={estado.receptor.verificadoArcaAt}>
            {horaPadron(estado.receptor.verificadoArcaAt)}
          </time>
        </span>
      </div>
    );
  }
  if (estado.estado === "ERROR") {
    return (
      <p
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive sm:col-span-2"
      >
        {estado.mensaje}
      </p>
    );
  }
  return (
    <p
      role="status"
      aria-live="polite"
      className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-medium sm:col-span-2"
    >
      Consultando CUIT en ARCA…
    </p>
  );
}

export function ReceptorFiscalForm({
  value,
  favoritos,
  clienteComercial,
  receptorHeredado,
  letraSolicitada,
  confirmaDatosManuales,
  estadoConsultaPadron = { estado: "SIN_CUIT" },
  claveConsultaPadron,
  errores = {},
  disabled,
  initialFocusRef,
  onChange,
  onConfirmaDatosManuales,
}: {
  value: ReceptorFormulario;
  favoritos: ReceptorFiscalFavorito[];
  clienteComercial: {
    razonSocial: string;
    documento: string | null;
    condicionIva: CondicionIva | null;
  };
  receptorHeredado?: ReceptorHeredadoVista | null;
  letraSolicitada: LetraSolicitada | null;
  confirmaDatosManuales: boolean;
  estadoConsultaPadron?: EstadoConsultaPadronUi;
  claveConsultaPadron: ClaveConsultaPadron | null;
  errores?: Partial<Record<CampoReceptorFiscal, string>>;
  disabled: boolean;
  initialFocusRef?: RefObject<HTMLInputElement | null>;
  onChange(value: ReceptorFormulario): void;
  onConfirmaDatosManuales(value: boolean): void;
}) {
  if (value.origen === "COMPROBANTE_ORIGINAL") {
    return (
      <fieldset disabled className="space-y-2">
        <legend className="text-sm font-semibold">Facturar a</legend>
        <p className="text-xs text-muted-foreground">
          Las notas conservan el receptor del comprobante original.
        </p>
        {receptorHeredado ? <DocumentoReceptor receptor={receptorHeredado} /> : null}
      </fieldset>
    );
  }

  const elegirManual = () => {
    onChange(
      value.origen === "MANUAL" && letraSolicitada
        ? adaptarReceptorFormularioALetra(value, letraSolicitada)
        : crearReceptorManualVacio(letraSolicitada),
    );
  };
  const condiciones = letraSolicitada
    ? CONDICIONES_POR_LETRA[letraSolicitada]
    : TODAS_LAS_CONDICIONES;
  const requiereDocumento =
    letraSolicitada !== "B" || (value.origen === "MANUAL" && value.condicion_iva === "EXENTO");
  const receptorVerificado =
    estadoConsultaPadron.estado === "VERIFICADO" &&
    estadoConsultaPadron.receptor.cuit === claveConsultaPadron?.cuit
      ? estadoConsultaPadron.receptor
      : null;

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-semibold">Facturar a</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex min-h-16 cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            id="receptor-cliente-comercial"
            ref={initialFocusRef}
            type="radio"
            className="mt-1"
            name="origen-receptor"
            checked={value.origen === "CLIENTE_COMERCIAL"}
            aria-invalid={errores.cliente_comercial ? true : undefined}
            aria-describedby={
              errores.cliente_comercial ? "error-receptor-cliente-comercial" : undefined
            }
            onChange={() => onChange({ origen: "CLIENTE_COMERCIAL" })}
          />
          <span>
            <strong className="block">Cliente comercial</strong>
            <span className="block text-xs text-muted-foreground">
              {letraSolicitada === null
                ? "La letra se determinará con sus datos fiscales confirmados."
                : "Sólo para factura B a Consumidor Final sin identificación fiscal."}
            </span>
          </span>
        </label>
        <label className="flex min-h-16 cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            className="mt-1"
            name="origen-receptor"
            checked={value.origen === "FAVORITO"}
            disabled={disabled || favoritos.length === 0}
            onChange={() => {
              const primero = favoritos[0];
              if (primero) onChange({ origen: "FAVORITO", receptor_fiscal_id: primero.id });
            }}
          />
          <span>
            <strong className="block">Guardado</strong>
            <span className="block text-xs text-muted-foreground">
              Reutiliza un receptor fiscal autorizado anteriormente.
            </span>
          </span>
        </label>
        <label className="flex min-h-16 cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            className="mt-1"
            name="origen-receptor"
            aria-label="Otro receptor"
            checked={value.origen === "MANUAL"}
            onChange={elegirManual}
          />
          <span>
            <strong className="block">Otro receptor</strong>
            <span className="block text-xs text-muted-foreground">
              Ingresá los datos de otra persona o empresa.
            </span>
          </span>
        </label>
      </div>

      {value.origen === "CLIENTE_COMERCIAL" ? (
        <div>
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
            <p className="font-semibold">{clienteComercial.razonSocial}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {clienteComercial.documento ?? "Sin documento cargado"} ·{" "}
              {clienteComercial.condicionIva
                ? ETIQUETA_CONDICION_IVA[clienteComercial.condicionIva]
                : "Condición fiscal sin confirmar"}
            </p>
          </div>
          {errores.cliente_comercial ? (
            <p
              id="error-receptor-cliente-comercial"
              role="alert"
              className="mt-1 text-xs font-medium text-destructive"
            >
              {errores.cliente_comercial}
            </p>
          ) : null}
        </div>
      ) : null}

      {value.origen === "FAVORITO" ? (
        <div>
          <Label htmlFor="receptor-favorito">Receptor guardado</Label>
          <select
            id="receptor-favorito"
            className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={value.receptor_fiscal_id}
            aria-invalid={errores.receptor ? true : undefined}
            aria-describedby={errores.receptor ? "error-receptor-favorito" : undefined}
            onChange={(event) =>
              onChange({ origen: "FAVORITO", receptor_fiscal_id: event.target.value })
            }
          >
            {favoritos.map((favorito) => (
              <option key={favorito.id} value={favorito.id}>
                {favorito.razon_social} · {favorito.tipo_documento} {favorito.numero_documento}
              </option>
            ))}
          </select>
          {errores.receptor ? (
            <p
              id="error-receptor-favorito"
              role="alert"
              className="mt-1 text-xs font-medium text-destructive"
            >
              {errores.receptor}
            </p>
          ) : null}
        </div>
      ) : null}

      {value.origen !== "MANUAL" ? (
        <EstadoPadron estado={estadoConsultaPadron} claveActual={claveConsultaPadron} />
      ) : null}

      {value.origen !== "MANUAL" && receptorVerificado ? (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="receptor-razon-social">Razón social oficial</Label>
            <Input
              id="receptor-razon-social"
              className="mt-1 min-h-11"
              value={receptorVerificado.razonSocial}
              readOnly
            />
          </div>
          <div>
            <Label htmlFor="receptor-condicion-iva">Condición de IVA informada</Label>
            <Input
              id="receptor-condicion-iva"
              className="mt-1 min-h-11"
              value={
                receptorVerificado.condicionIvaConfirmada
                  ? ETIQUETA_CONDICION_IVA[receptorVerificado.condicionIvaConfirmada]
                  : "ARCA no confirmó una condición"
              }
              readOnly
            />
          </div>
          <div>
            <Label htmlFor="receptor-domicilio">Domicilio fiscal oficial</Label>
            <Input
              id="receptor-domicilio"
              className="mt-1 min-h-11"
              value={receptorVerificado.domicilioFiscal ?? "Sin domicilio informado por ARCA"}
              readOnly
            />
          </div>
        </div>
      ) : null}

      {value.origen === "MANUAL" ? (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          {letraSolicitada === "B" ? (
            <div>
              <Label htmlFor="receptor-tipo-documento">
                Tipo de documento{requiereDocumento ? "" : " (opcional)"}
              </Label>
              <select
                id="receptor-tipo-documento"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={value.tipo_documento}
                aria-invalid={errores.tipo_documento ? true : undefined}
                aria-describedby={
                  errores.tipo_documento ? "error-receptor-tipo-documento" : undefined
                }
                onChange={(event) => {
                  const tipo = event.target.value as TipoDocumentoFiscal;
                  onChange({
                    ...value,
                    tipo_documento: tipo,
                    numero_documento: tipo === "SIN_IDENTIFICAR" ? "" : value.numero_documento,
                    guardar_para_proximas:
                      tipo === "SIN_IDENTIFICAR" ? false : value.guardar_para_proximas,
                  });
                }}
              >
                <option value="SIN_IDENTIFICAR">Sin identificar</option>
                <option value="CUIT">CUIT</option>
                <option value="CUIL">CUIL</option>
                <option value="DNI">DNI</option>
                <option value="CDI">CDI</option>
              </select>
              {errores.tipo_documento ? (
                <p
                  id="error-receptor-tipo-documento"
                  role="alert"
                  className="mt-1 text-xs font-medium text-destructive"
                >
                  {errores.tipo_documento}
                </p>
              ) : null}
            </div>
          ) : null}
          <div>
            <Label htmlFor="receptor-numero-documento">
              {letraSolicitada === "A" || letraSolicitada === null
                ? "CUIT"
                : `Número de documento${requiereDocumento ? "" : " (opcional)"}`}
            </Label>
            <Input
              id="receptor-numero-documento"
              className="mt-1 min-h-11"
              inputMode="numeric"
              value={value.numero_documento}
              disabled={disabled || value.tipo_documento === "SIN_IDENTIFICAR"}
              required={requiereDocumento}
              aria-invalid={errores.numero_documento ? true : undefined}
              aria-describedby={
                errores.numero_documento
                  ? "ayuda-documento-fiscal error-receptor-numero-documento"
                  : "ayuda-documento-fiscal"
              }
              onChange={(event) => onChange({ ...value, numero_documento: event.target.value })}
            />
            <p id="ayuda-documento-fiscal" className="mt-1 text-xs text-muted-foreground">
              {letraSolicitada === "A"
                ? "La factura A requiere el CUIT del receptor."
                : letraSolicitada === null
                  ? "Para la letra automática, ingresá el CUIT y la condición fiscal del receptor."
                  : requiereDocumento
                    ? "Los receptores Exentos deben identificarse con un documento válido."
                    : "Podés emitir sin identificación o elegir el tipo explícitamente."}
            </p>
            {errores.numero_documento ? (
              <p
                id="error-receptor-numero-documento"
                role="alert"
                className="mt-1 text-xs font-medium text-destructive"
              >
                {errores.numero_documento}
              </p>
            ) : null}
          </div>
          <EstadoPadron estado={estadoConsultaPadron} claveActual={claveConsultaPadron} />
          <div className="sm:col-span-2">
            <Label htmlFor="receptor-razon-social">Razón social</Label>
            <Input
              id="receptor-razon-social"
              className="mt-1 min-h-11"
              value={receptorVerificado?.razonSocial ?? value.razon_social}
              required
              readOnly={receptorVerificado !== null}
              aria-invalid={errores.razon_social ? true : undefined}
              aria-describedby={errores.razon_social ? "error-receptor-razon-social" : undefined}
              onChange={(event) => onChange({ ...value, razon_social: event.target.value })}
            />
            {errores.razon_social ? (
              <p
                id="error-receptor-razon-social"
                role="alert"
                className="mt-1 text-xs font-medium text-destructive"
              >
                {errores.razon_social}
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="receptor-condicion-iva">Condición de IVA</Label>
            {receptorVerificado?.condicionIvaConfirmada ? (
              <Input
                id="receptor-condicion-iva"
                className="mt-1 min-h-11"
                value={ETIQUETA_CONDICION_IVA[receptorVerificado.condicionIvaConfirmada]}
                readOnly
              />
            ) : (
              <select
                id="receptor-condicion-iva"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={value.condicion_iva}
                required
                aria-invalid={errores.condicion_iva ? true : undefined}
                aria-describedby={
                  errores.condicion_iva ? "error-receptor-condicion-iva" : undefined
                }
                onChange={(event) =>
                  onChange({ ...value, condicion_iva: event.target.value as CondicionIva })
                }
              >
                {condiciones.map((condicion) => (
                  <option key={condicion.value} value={condicion.value}>
                    {condicion.label}
                  </option>
                ))}
              </select>
            )}
            {errores.condicion_iva ? (
              <p
                id="error-receptor-condicion-iva"
                role="alert"
                className="mt-1 text-xs font-medium text-destructive"
              >
                {errores.condicion_iva}
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="receptor-domicilio">
              {receptorVerificado ? "Domicilio fiscal oficial" : "Domicilio"}
            </Label>
            <Input
              id="receptor-domicilio"
              className="mt-1 min-h-11"
              value={
                receptorVerificado
                  ? (receptorVerificado.domicilioFiscal ?? "Sin domicilio informado por ARCA")
                  : value.domicilio
              }
              readOnly={receptorVerificado !== null}
              onChange={(event) => onChange({ ...value, domicilio: event.target.value })}
            />
          </div>
          <label className="flex min-h-11 items-start gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={value.guardar_para_proximas}
              disabled={disabled || value.tipo_documento === "SIN_IDENTIFICAR"}
              onChange={(event) =>
                onChange({ ...value, guardar_para_proximas: event.target.checked })
              }
            />
            <span>
              <strong>Guardar para próximas facturas</strong>
              <span className="block text-xs text-muted-foreground">
                Se guarda recién después de que ARCA autorice el comprobante.
              </span>
            </span>
          </label>
          {receptorVerificado ? null : (
            <div className="sm:col-span-2">
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
                <input
                  id="confirmar-datos-receptor"
                  type="checkbox"
                  className="mt-1"
                  checked={confirmaDatosManuales}
                  aria-invalid={errores.confirmacion ? true : undefined}
                  aria-describedby={
                    errores.confirmacion ? "error-confirmar-datos-receptor" : undefined
                  }
                  onChange={(event) => onConfirmaDatosManuales(event.target.checked)}
                />
                <span>Confirmo que revisé el documento y los datos fiscales ingresados.</span>
              </label>
              {errores.confirmacion ? (
                <p
                  id="error-confirmar-datos-receptor"
                  role="alert"
                  className="mt-1 text-xs font-medium text-destructive"
                >
                  {errores.confirmacion}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
