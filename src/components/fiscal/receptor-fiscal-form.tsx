import type { RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { ReceptorFiscalConfirmado, TipoDocumentoFiscal } from "@/lib/fiscal/receptor";
import type { CondicionIva } from "@/lib/fiscal/codigos";

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

function crearReceptorManualVacio(): Extract<ReceptorFormulario, { origen: "MANUAL" }> {
  return {
    origen: "MANUAL",
    tipo_documento: "CUIT",
    numero_documento: "",
    razon_social: "",
    condicion_iva: "CONSUMIDOR_FINAL",
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

export function ReceptorFiscalForm({
  value,
  favoritos,
  clienteComercial,
  receptorHeredado,
  confirmaDatosManuales,
  disabled,
  initialFocusRef,
  onChange,
  onConfirmaDatosManuales,
}: {
  value: ReceptorFormulario;
  favoritos: ReceptorFiscalFavorito[];
  clienteComercial: { razonSocial: string; documento: string | null };
  receptorHeredado?: ReceptorHeredadoVista | null;
  confirmaDatosManuales: boolean;
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

  const elegirManual = () =>
    onChange(value.origen === "MANUAL" ? value : crearReceptorManualVacio());

  return (
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="text-sm font-semibold">Facturar a</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            ref={initialFocusRef}
            type="radio"
            name="origen-receptor"
            checked={value.origen === "CLIENTE_COMERCIAL"}
            onChange={() => onChange({ origen: "CLIENTE_COMERCIAL" })}
          />
          Cliente comercial
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            name="origen-receptor"
            checked={value.origen === "FAVORITO"}
            disabled={disabled || favoritos.length === 0}
            onChange={() => {
              const primero = favoritos[0];
              if (primero) onChange({ origen: "FAVORITO", receptor_fiscal_id: primero.id });
            }}
          />
          Guardado
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
          <input
            type="radio"
            name="origen-receptor"
            checked={value.origen === "MANUAL"}
            onChange={elegirManual}
          />
          Otro receptor
        </label>
      </div>

      {value.origen === "CLIENTE_COMERCIAL" ? (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <p className="font-semibold">{clienteComercial.razonSocial}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {clienteComercial.documento ?? "Sin documento cargado"}
          </p>
        </div>
      ) : null}

      {value.origen === "FAVORITO" ? (
        <div>
          <Label htmlFor="receptor-favorito">Receptor guardado</Label>
          <select
            id="receptor-favorito"
            className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={value.receptor_fiscal_id}
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
        </div>
      ) : null}

      {value.origen === "MANUAL" ? (
        <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="receptor-tipo-documento">Tipo de documento</Label>
            <select
              id="receptor-tipo-documento"
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={value.tipo_documento}
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
              <option value="CUIT">CUIT</option>
              <option value="CUIL">CUIL</option>
              <option value="DNI">DNI</option>
              <option value="CDI">CDI</option>
              <option value="SIN_IDENTIFICAR">Sin identificar</option>
            </select>
          </div>
          <div>
            <Label htmlFor="receptor-numero-documento">Número de documento</Label>
            <Input
              id="receptor-numero-documento"
              className="mt-1 min-h-11"
              inputMode="numeric"
              value={value.numero_documento}
              disabled={disabled || value.tipo_documento === "SIN_IDENTIFICAR"}
              aria-describedby="ayuda-documento-fiscal"
              onChange={(event) => onChange({ ...value, numero_documento: event.target.value })}
            />
            <p id="ayuda-documento-fiscal" className="mt-1 text-xs text-muted-foreground">
              Elegí el tipo explícitamente; el sistema no lo infiere por longitud.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="receptor-razon-social">Razón social</Label>
            <Input
              id="receptor-razon-social"
              className="mt-1 min-h-11"
              value={value.razon_social}
              onChange={(event) => onChange({ ...value, razon_social: event.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="receptor-condicion-iva">Condición de IVA</Label>
            <select
              id="receptor-condicion-iva"
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={value.condicion_iva}
              onChange={(event) =>
                onChange({ ...value, condicion_iva: event.target.value as CondicionIva })
              }
            >
              <option value="RESPONSABLE_INSCRIPTO">Responsable inscripto</option>
              <option value="MONOTRIBUTO">Monotributo</option>
              <option value="EXENTO">Exento</option>
              <option value="CONSUMIDOR_FINAL">Consumidor final</option>
            </select>
          </div>
          <div>
            <Label htmlFor="receptor-domicilio">Domicilio</Label>
            <Input
              id="receptor-domicilio"
              className="mt-1 min-h-11"
              value={value.domicilio}
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
          <label className="flex min-h-11 items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmaDatosManuales}
              onChange={(event) => onConfirmaDatosManuales(event.target.checked)}
            />
            <span>Confirmo que revisé el documento y los datos fiscales ingresados.</span>
          </label>
        </div>
      ) : null}
    </fieldset>
  );
}
