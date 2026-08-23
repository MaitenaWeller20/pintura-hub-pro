import { useRef, useState, type RefObject } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ReceptorFiscalFavorito } from "@/lib/fiscal/cola.functions";
import type { SelectorReceptorFiscal } from "@/lib/fiscal/receptor";
import {
  ReceptorFiscalForm,
  type ReceptorFormulario,
  type ReceptorHeredadoVista,
} from "./receptor-fiscal-form";
import { ResumenEmisionFiscal, type PreviewEmisionFiscal } from "./resumen-emision-fiscal";
import { textoValidezFiscal } from "@/lib/fiscal/validez-ui";
import {
  cambiarReceptorConfirmacion,
  crearControlSolicitudPreview,
  crearEstadoConfirmacionFiscal,
  esSolicitudPreviewActual,
  finalizarSolicitudPreview,
  iniciarSolicitudPreview,
  invalidarSolicitudPreview,
  registrarPreviewConfirmacion,
  registrarReconfirmacion,
} from "./dialogo-emision-state";
import {
  despacharRespuestaConfirmacionFiscal,
  parsePreviewEmisionFiscal,
  type RespuestaReconfirmacion,
  type ResultadoEmisionFiscalUi,
} from "./dialogo-emision-contract";

export type ContextoDialogoEmision = {
  comprador: { razonSocial: string; documento: string | null };
  emisor: { razonSocial: string; cuit: string };
  sucursal: {
    nombre: string;
    puntoVenta: number | null;
    modo: "PRODUCCION" | "HOMOLOGACION" | null;
  };
  tipoComprobante: string;
  receptorHeredado?: ReceptorHeredadoVista | null;
};

function selectorListo(
  value: ReceptorFormulario,
  confirmaDatosManuales: boolean,
): SelectorReceptorFiscal {
  if (value.origen !== "MANUAL") return value;
  if (!confirmaDatosManuales) {
    throw new Error("Confirmá expresamente los datos del receptor manual.");
  }
  return {
    origen: "MANUAL",
    tipo_documento: value.tipo_documento,
    numero_documento: value.tipo_documento === "SIN_IDENTIFICAR" ? null : value.numero_documento,
    razon_social: value.razon_social,
    condicion_iva: value.condicion_iva,
    domicilio: value.domicilio.trim() ? value.domicilio : null,
    guardar_para_proximas: value.guardar_para_proximas,
    confirma_datos_manuales: true,
  };
}

function previewReconfirmada(
  anterior: PreviewEmisionFiscal,
  respuesta: RespuestaReconfirmacion,
): PreviewEmisionFiscal {
  const autoritativa = respuesta.confirmacion_autoritativa;
  if (anterior.autoritativo) {
    return {
      ...anterior,
      total: autoritativa.importe,
      // La respuesta autoritativa sólo confirma el importe fiscal. No se deriva
      // un saldo en el navegador: el servidor lo volverá a presentar al emitir.
      saldo: anterior.saldo,
      fecha_fiscal: autoritativa.fechaFiscal,
      receptor: autoritativa.receptor,
      letra: autoritativa.letra,
      razon_letra: `La condición ${autoritativa.receptor.condicionIva} determina letra ${autoritativa.letra}.`,
      emisor_cuit: autoritativa.emisorCuit,
      emisor_razon_social: autoritativa.emisorRazonSocial,
      sucursal_id: autoritativa.sucursalId,
      sucursal_nombre: autoritativa.sucursalNombre,
      punto_venta: autoritativa.puntoVenta,
      modo: autoritativa.modo,
      cbte_tipo: autoritativa.cbteTipo,
      confirmacion_autoritativa: autoritativa,
      huella_confirmacion: respuesta.huella_confirmacion,
    };
  }
  return {
    ...anterior,
    total: autoritativa.importe,
    saldo: anterior.saldo,
    fecha_fiscal: autoritativa.fechaFiscal,
    receptor: autoritativa.receptor,
    letra: autoritativa.letra,
    razon_letra: `La condición ${autoritativa.receptor.condicionIva} determina letra ${autoritativa.letra}.`,
    emisor_cuit: autoritativa.emisorCuit,
    emisor_razon_social: autoritativa.emisorRazonSocial,
    sucursal_id: autoritativa.sucursalId,
    sucursal_nombre: autoritativa.sucursalNombre,
    punto_venta: autoritativa.puntoVenta,
    modo: autoritativa.modo,
    cbte_tipo: autoritativa.cbteTipo,
    huella_confirmacion: respuesta.huella_confirmacion,
    confirmacion_provisional: {
      version: 1,
      importe: autoritativa.importe,
      emisor_cuit: autoritativa.emisorCuit,
      emisor_razon_social: autoritativa.emisorRazonSocial,
      sucursal_id: autoritativa.sucursalId,
      sucursal_nombre: autoritativa.sucursalNombre,
      punto_venta: autoritativa.puntoVenta,
      modo: autoritativa.modo,
      letra: autoritativa.letra,
      cbte_tipo: autoritativa.cbteTipo,
      fecha_fiscal: autoritativa.fechaFiscal,
      receptor: autoritativa.receptor,
    },
  };
}

export function DialogoEmisionFiscal({
  open,
  contexto,
  favoritos,
  returnFocusRef,
  puedeConfirmarVentaAntigua = false,
  onOpenChange,
  onPrevisualizar,
  onConfirmar,
  onCompletada,
}: {
  open: boolean;
  contexto: ContextoDialogoEmision;
  favoritos: ReceptorFiscalFavorito[];
  returnFocusRef?: RefObject<HTMLElement | null>;
  puedeConfirmarVentaAntigua?: boolean;
  onOpenChange(open: boolean): void;
  onPrevisualizar(receptor: SelectorReceptorFiscal): Promise<unknown>;
  onConfirmar(input: {
    receptor: SelectorReceptorFiscal;
    confirmaVentaAntigua: boolean;
    huellaConfirmacion: string;
  }): Promise<unknown>;
  onCompletada?(result: ResultadoEmisionFiscalUi): void;
}) {
  const esNota =
    contexto.tipoComprobante === "NOTA_CREDITO" || contexto.tipoComprobante === "NOTA_DEBITO";
  const receptorInicial: ReceptorFormulario = esNota
    ? { origen: "COMPROBANTE_ORIGINAL" }
    : { origen: "CLIENTE_COMERCIAL" };
  const [receptor, setReceptor] = useState<ReceptorFormulario>(receptorInicial);
  const [confirmacion, setConfirmacion] = useState(crearEstadoConfirmacionFiscal);
  const [preview, setPreview] = useState<PreviewEmisionFiscal | null>(null);
  const [confirmaVentaAntigua, setConfirmaVentaAntigua] = useState(false);
  const [previsualizando, setPrevisualizando] = useState(false);
  const [emitiendo, setEmitiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const previewControlRef = useRef(crearControlSolicitudPreview());
  const emitiendoRef = useRef(false);

  const reiniciar = () => {
    setReceptor(receptorInicial);
    setConfirmacion(crearEstadoConfirmacionFiscal());
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setPrevisualizando(false);
    setError(null);
    invalidarSolicitudPreview(previewControlRef.current);
  };

  const cerrar = () => {
    if (emitiendoRef.current) return;
    reiniciar();
    onOpenChange(false);
  };

  const cambiarReceptor = (siguiente: ReceptorFormulario) => {
    invalidarSolicitudPreview(previewControlRef.current);
    setPrevisualizando(false);
    setReceptor(siguiente);
    setConfirmacion((actual) => cambiarReceptorConfirmacion(actual));
    setPreview(null);
    setConfirmaVentaAntigua(false);
    setError(null);
  };

  const preparar = async () => {
    const token = iniciarSolicitudPreview(previewControlRef.current);
    if (token === null) return;
    setPrevisualizando(true);
    setError(null);
    try {
      const selector = selectorListo(receptor, confirmacion.confirmaDatosManuales);
      const resultado = parsePreviewEmisionFiscal(await onPrevisualizar(selector));
      if (!esSolicitudPreviewActual(previewControlRef.current, token)) return;
      setPreview(resultado);
      setConfirmacion((actual) =>
        registrarPreviewConfirmacion(actual, resultado.huella_confirmacion),
      );
    } catch (cause) {
      if (esSolicitudPreviewActual(previewControlRef.current, token)) {
        setError(cause instanceof Error ? cause.message : "No se pudo revisar la emisión fiscal.");
      }
    } finally {
      if (esSolicitudPreviewActual(previewControlRef.current, token)) {
        setPrevisualizando(false);
      }
      finalizarSolicitudPreview(previewControlRef.current, token);
    }
  };

  const confirmar = async () => {
    if (!preview || !confirmacion.huellaConfirmacion || emitiendoRef.current) return;
    emitiendoRef.current = true;
    setEmitiendo(true);
    setError(null);
    try {
      const selector = selectorListo(receptor, confirmacion.confirmaDatosManuales);
      const respuesta = await onConfirmar({
        receptor: selector,
        confirmaVentaAntigua,
        huellaConfirmacion: confirmacion.huellaConfirmacion,
      });
      despacharRespuestaConfirmacionFiscal(respuesta, {
        onReconfirmacion(resultado) {
          setPreview(previewReconfirmada(preview, resultado));
          setConfirmacion((actual) =>
            registrarReconfirmacion(actual, resultado.huella_confirmacion),
          );
          setConfirmaVentaAntigua(false);
          setError(resultado.mensaje);
        },
        onCompletada(resultado) {
          onCompletada?.(resultado);
          reiniciar();
          onOpenChange(false);
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo emitir el comprobante.");
    } finally {
      emitiendoRef.current = false;
      setEmitiendo(false);
    }
  };

  const puedeEmitir =
    preview !== null &&
    confirmacion.huellaConfirmacion !== null &&
    (!preview.advertencia_demora || (puedeConfirmarVentaAntigua && confirmaVentaAntigua)) &&
    !(preview.letra === "A" && !preview.confirmacion_factura_a_permitida) &&
    (receptor.origen !== "MANUAL" || confirmacion.confirmaDatosManuales);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (emitiendoRef.current) return;
        if (!next) reiniciar();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] max-w-3xl overflow-hidden p-0"
        data-testid="dialogo-emision-fiscal"
        closeDisabled={emitiendo}
        hideClose={emitiendo}
        onOpenAutoFocus={(event) => {
          if (!esNota) {
            event.preventDefault();
            initialFocusRef.current?.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <div className="px-4 pt-5 sm:px-6">
          <DialogHeader>
            <DialogTitle>Revisar y emitir comprobante</DialogTitle>
            <DialogDescription>
              Facturar no vuelve a cobrar ni modifica la deuda de la venta.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div
          className="max-h-[calc(100dvh-12rem)] space-y-5 overflow-y-auto px-4 sm:px-6"
          data-testid="dialogo-emision-scroll"
        >
          <section className="grid gap-3 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Comprador / deudor
              </p>
              <p className="font-semibold">{contexto.comprador.razonSocial}</p>
              <p className="text-xs text-muted-foreground">
                {contexto.comprador.documento ?? "Sin documento cargado"}
              </p>
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Emisión
              </p>
              {preview ? (
                <>
                  <p className="font-semibold">{preview.emisor_razon_social}</p>
                  <p className="text-xs text-muted-foreground">
                    CUIT {preview.emisor_cuit} · {preview.sucursal_nombre} · PV{" "}
                    {String(preview.punto_venta).padStart(5, "0")} ·{" "}
                    {textoValidezFiscal(preview.afip_validez)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  El servidor resolverá emisor, sucursal, punto de venta y ambiente al revisar.
                </p>
              )}
            </div>
          </section>

          <ReceptorFiscalForm
            value={receptor}
            favoritos={favoritos}
            clienteComercial={contexto.comprador}
            receptorHeredado={contexto.receptorHeredado}
            confirmaDatosManuales={confirmacion.confirmaDatosManuales}
            disabled={emitiendo || previsualizando}
            initialFocusRef={initialFocusRef}
            onChange={cambiarReceptor}
            onConfirmaDatosManuales={(value) =>
              setConfirmacion((actual) => ({ ...actual, confirmaDatosManuales: value }))
            }
          />

          {preview ? (
            <ResumenEmisionFiscal
              preview={preview}
              comprador={contexto.comprador.razonSocial}
              requiereSegundaConfirmacion={confirmacion.requiereSegundaConfirmacion}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
              Revisá el receptor para que el servidor calcule la letra, fecha e importe fiscal.
            </div>
          )}

          {preview?.advertencia_demora && puedeConfirmarVentaAntigua ? (
            <label className="flex min-h-11 items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmaVentaAntigua}
                disabled={emitiendo}
                onChange={(event) => setConfirmaVentaAntigua(event.target.checked)}
              />
              <span>Confirmo emitir esta venta demorada con la fecha fiscal informada.</span>
            </label>
          ) : preview?.advertencia_demora ? (
            <p
              role="alert"
              className="rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm font-medium text-warning"
            >
              Esta venta demorada sólo puede ser confirmada y emitida por un administrador.
            </p>
          ) : null}

          <div aria-live="polite" aria-atomic="true">
            {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
            {emitiendo ? (
              <p className="flex items-center gap-2 text-sm font-semibold text-primary">
                <Loader2 className="h-4 w-4 animate-spin" /> Emitiendo en ARCA…
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter className="sticky bottom-0 z-10 border-t border-border bg-background px-4 pb-4 pt-3 shadow-[0_-8px_18px_-16px_hsl(var(--foreground))] sm:px-6">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            disabled={emitiendo}
            onClick={cerrar}
          >
            Cancelar
          </Button>
          {preview ? (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={!puedeEmitir || emitiendo}
              onClick={confirmar}
            >
              {emitiendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck />}
              {emitiendo
                ? "Emitiendo en ARCA…"
                : confirmacion.requiereSegundaConfirmacion
                  ? "Confirmar cambios y emitir"
                  : "Emitir comprobante"}
            </Button>
          ) : (
            <Button
              type="button"
              className="min-h-11 w-full sm:w-auto"
              disabled={previsualizando || emitiendo}
              onClick={preparar}
            >
              {previsualizando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {previsualizando ? "Revisando…" : "Revisar datos fiscales"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
