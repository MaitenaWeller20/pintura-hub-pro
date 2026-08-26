import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, History, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  calcularCorreccionCierre,
  mensajeErrorCorreccionCaja,
  validarCorreccionCierre,
} from "@/lib/cierre-caja";
import { fmtDateTime, fmtMoney } from "@/lib/format";

export type CierreCajaCorregible = Database["public"]["Tables"]["caja_sesiones"]["Row"];

type FormaEsperada = { entra?: number; sale?: number; neto?: number };
type CorreccionCaja = Database["public"]["Tables"]["caja_cierre_correcciones"]["Row"] & {
  editor: { nombre_completo: string | null; username: string } | null;
};

const ETIQUETA_CAMPO: Record<string, string> = {
  efectivo_contado: "Efectivo contado",
  efectivo_dejado: "Efectivo dejado",
  notas: "Observaciones",
};

function esRegistro(value: Json | undefined): value is { [key: string]: Json | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapaEsperado(value: Json | null): Record<string, FormaEsperada> {
  const registro = value ?? undefined;
  if (!esRegistro(registro)) return {};
  return Object.fromEntries(
    Object.entries(registro).map(([forma, detalle]) => {
      if (esRegistro(detalle)) {
        return [forma, { neto: Number(detalle.neto ?? 0) }];
      }
      return [forma, { neto: Number(detalle ?? 0) }];
    }),
  );
}

function mapaContado(value: Json | null): Record<string, number> {
  const registro = value ?? undefined;
  if (!esRegistro(registro)) return {};
  return Object.fromEntries(
    Object.entries(registro).map(([forma, monto]) => [forma, Number(monto ?? 0)]),
  );
}

function registroSnapshot(value: Json): { [key: string]: Json | undefined } {
  return esRegistro(value) ? value : {};
}

function numeroSnapshot(value: Json, campo: string): number {
  return Number(registroSnapshot(value)[campo] ?? 0);
}

function efectivoContadoSnapshot(value: Json): number {
  const contado = registroSnapshot(value).contado;
  return esRegistro(contado) ? Number(contado.EFECTIVO ?? 0) : 0;
}

function notasSnapshot(value: Json): string {
  const notas = registroSnapshot(value).notas;
  return typeof notas === "string" && notas.trim() ? notas : "Sin observaciones";
}

function ComparacionImporte({
  etiqueta,
  anterior,
  nuevo,
}: {
  etiqueta: string;
  anterior: number;
  nuevo: number;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 text-sm">
      <span className="text-muted-foreground">{etiqueta}</span>
      <span className="font-mono tabular-nums">{fmtMoney(anterior)}</span>
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="font-mono font-semibold tabular-nums">{fmtMoney(nuevo)}</span>
    </div>
  );
}

export function DialogoCorreccionCierre({
  sesion,
  tieneTurnoPosterior,
  onClose,
  onSaved,
}: {
  sesion: CierreCajaCorregible;
  tieneTurnoPosterior: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const contadoActual = mapaContado(sesion.contado);
  const efectivoContadoActual = Number(contadoActual.EFECTIVO ?? 0);
  const efectivoDejadoActual = Number(sesion.efectivo_dejado ?? 0);
  const [efectivoContado, setEfectivoContado] = useState<number | null>(efectivoContadoActual);
  const [efectivoDejado, setEfectivoDejado] = useState<number | null>(efectivoDejadoActual);
  const [notas, setNotas] = useState(sesion.notas ?? "");
  const [motivo, setMotivo] = useState("");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  const resumen =
    efectivoContado === null || efectivoDejado === null
      ? null
      : calcularCorreccionCierre({
          esperado: mapaEsperado(sesion.esperado),
          contadoActual,
          efectivoContado,
          efectivoDejado,
        });

  const guardar = useMutation({
    mutationFn: async () => {
      if (efectivoContado === null || efectivoDejado === null) {
        throw new Error("Completá el efectivo contado y el efectivo dejado.");
      }
      const validacion = validarCorreccionCierre({
        efectivoContadoActual,
        efectivoDejadoActual,
        efectivoContado,
        efectivoDejado,
        motivo,
        tieneTurnoPosterior,
      });
      if (validacion) throw new Error(validacion);
      const { error } = await supabase.rpc("corregir_cierre_caja", {
        p_sesion_id: sesion.id,
        p_efectivo_contado: efectivoContado,
        p_efectivo_dejado: efectivoDejado,
        p_notas: notas,
        p_motivo: motivo.trim(),
        p_version_esperada: sesion.correccion_version,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Cierre corregido y auditado");
      onSaved();
    },
    onError: (error) => setErrorLocal(mensajeErrorCorreccionCaja(error)),
  });

  const limpiarError = () => {
    setErrorLocal(null);
    guardar.reset();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !guardar.isPending && onClose()}>
      <DialogContent className="max-w-2xl" closeDisabled={guardar.isPending}>
        <DialogHeader>
          <DialogTitle>Corregir cierre de caja</DialogTitle>
          <DialogDescription>
            Sólo un administrador puede guardar cambios. Se registrarán tu identidad, el motivo y
            los valores anteriores y nuevos.
          </DialogDescription>
        </DialogHeader>

        <Alert>
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>El cierre original no se borra</AlertTitle>
          <AlertDescription>
            La corrección recalcula contado, diferencia y totales, y agrega una nueva versión al
            historial.
          </AlertDescription>
        </Alert>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setErrorLocal(null);
            guardar.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="correccion-efectivo-contado">Efectivo contado</Label>
              <NumberInput
                id="correccion-efectivo-contado"
                className="mt-1 min-h-11 text-right"
                value={efectivoContado}
                min={0}
                autoFocus
                disabled={guardar.isPending}
                onValueChange={(value) => {
                  limpiarError();
                  setEfectivoContado(value);
                }}
              />
            </div>
            <div>
              <Label htmlFor="correccion-efectivo-dejado">Efectivo dejado</Label>
              <NumberInput
                id="correccion-efectivo-dejado"
                className="mt-1 min-h-11 text-right"
                value={efectivoDejado}
                min={0}
                disabled={tieneTurnoPosterior || guardar.isPending}
                aria-describedby={
                  tieneTurnoPosterior ? "ayuda-fondo-turno-posterior" : "ayuda-efectivo-dejado"
                }
                onValueChange={(value) => {
                  limpiarError();
                  setEfectivoDejado(value);
                }}
              />
              <p
                id={tieneTurnoPosterior ? "ayuda-fondo-turno-posterior" : "ayuda-efectivo-dejado"}
                className="mt-1 text-xs text-muted-foreground"
              >
                {tieneTurnoPosterior
                  ? "No se puede cambiar: un turno posterior ya tomó este fondo inicial."
                  : "Es el fondo que recibió el turno siguiente."}
              </p>
            </div>
          </div>

          {resumen ? (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Resultado</span>
                <span>Antes</span>
                <span aria-hidden="true" />
                <span>Después</span>
              </div>
              <ComparacionImporte
                etiqueta="Efectivo contado"
                anterior={efectivoContadoActual}
                nuevo={resumen.contado.EFECTIVO}
              />
              <ComparacionImporte
                etiqueta="Efectivo dejado"
                anterior={efectivoDejadoActual}
                nuevo={Number(efectivoDejado)}
              />
              <ComparacionImporte
                etiqueta="Efectivo retirado"
                anterior={efectivoContadoActual - efectivoDejadoActual}
                nuevo={resumen.efectivoRetirado}
              />
              <ComparacionImporte
                etiqueta="Diferencia total"
                anterior={Number(sesion.total_diferencia ?? 0)}
                nuevo={resumen.totalDiferencia}
              />
            </div>
          ) : null}

          <div>
            <Label htmlFor="correccion-notas">Observaciones del cierre</Label>
            <Textarea
              id="correccion-notas"
              className="mt-1"
              rows={2}
              maxLength={2000}
              value={notas}
              disabled={guardar.isPending}
              placeholder="Ej: faltante justificado por vuelto mal dado"
              onChange={(event) => {
                limpiarError();
                setNotas(event.target.value);
              }}
            />
          </div>

          <div>
            <Label htmlFor="correccion-motivo">Motivo de la corrección</Label>
            <Textarea
              id="correccion-motivo"
              className="mt-1"
              rows={3}
              required
              minLength={5}
              maxLength={1000}
              value={motivo}
              disabled={guardar.isPending}
              aria-describedby="ayuda-motivo-correccion"
              placeholder="Ej: se omitió un billete de $10.000 al informar el conteo"
              onChange={(event) => {
                limpiarError();
                setMotivo(event.target.value);
              }}
            />
            <p id="ayuda-motivo-correccion" className="mt-1 text-xs text-muted-foreground">
              Explicá qué dato estaba mal y cómo lo verificaste. Este texto queda en la auditoría.
            </p>
          </div>

          {errorLocal ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorLocal}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={guardar.isPending} onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={guardar.isPending || efectivoContado === null || efectivoDejado === null}
            >
              {guardar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              {guardar.isPending ? "Guardando…" : "Guardar corrección"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DialogoHistorialCorrecciones({
  sesion,
  onClose,
}: {
  sesion: CierreCajaCorregible;
  onClose(): void;
}) {
  const historial = useQuery({
    queryKey: ["caja-correcciones", sesion.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("caja_cierre_correcciones")
        .select(
          "id,caja_sesion_id,corregida_por,corregida_en,motivo,version_anterior,version_nueva,valores_anteriores,valores_nuevos,campos_modificados,editor:profiles!caja_cierre_correcciones_corregida_por_fkey(nombre_completo,username)",
        )
        .eq("caja_sesion_id", sesion.id)
        .order("version_nueva", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CorreccionCaja[];
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-5 w-5" /> Historial de correcciones
          </DialogTitle>
          <DialogDescription>
            Cierre del {fmtDateTime(sesion.cerrada_en)} · versión {sesion.correccion_version}
          </DialogDescription>
        </DialogHeader>

        {historial.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando auditoría…
          </p>
        ) : historial.error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>No se pudo cargar el historial</AlertTitle>
            <AlertDescription>{mensajeErrorCorreccionCaja(historial.error)}</AlertDescription>
          </Alert>
        ) : historial.data?.length ? (
          <div className="space-y-3">
            {historial.data.map((correccion) => (
              <article key={correccion.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">
                      Versión {correccion.version_nueva} ·{" "}
                      {correccion.editor?.nombre_completo ||
                        correccion.editor?.username ||
                        "Administrador"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDateTime(correccion.corregida_en)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {correccion.campos_modificados.map((campo) => (
                      <Badge key={campo} variant="outline">
                        {ETIQUETA_CAMPO[campo] ?? campo}
                      </Badge>
                    ))}
                  </div>
                </div>

                <p className="mt-3 rounded-md bg-muted/40 p-2 text-sm">
                  <span className="font-semibold">Motivo:</span> {correccion.motivo}
                </p>
                <div className="mt-3 space-y-2">
                  <ComparacionImporte
                    etiqueta="Efectivo contado"
                    anterior={efectivoContadoSnapshot(correccion.valores_anteriores)}
                    nuevo={efectivoContadoSnapshot(correccion.valores_nuevos)}
                  />
                  <ComparacionImporte
                    etiqueta="Efectivo dejado"
                    anterior={numeroSnapshot(correccion.valores_anteriores, "efectivo_dejado")}
                    nuevo={numeroSnapshot(correccion.valores_nuevos, "efectivo_dejado")}
                  />
                  <ComparacionImporte
                    etiqueta="Diferencia total"
                    anterior={numeroSnapshot(correccion.valores_anteriores, "total_diferencia")}
                    nuevo={numeroSnapshot(correccion.valores_nuevos, "total_diferencia")}
                  />
                </div>
                {correccion.campos_modificados.includes("notas") ? (
                  <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded-md border border-border p-2">
                      <span className="font-semibold text-muted-foreground">
                        Observación anterior
                      </span>
                      <p className="mt-1">{notasSnapshot(correccion.valores_anteriores)}</p>
                    </div>
                    <div className="rounded-md border border-border p-2">
                      <span className="font-semibold text-muted-foreground">Observación nueva</span>
                      <p className="mt-1">{notasSnapshot(correccion.valores_nuevos)}</p>
                    </div>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Este cierre todavía no tiene correcciones.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
