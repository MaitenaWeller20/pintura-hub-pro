import type { ReactElement } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, ShieldX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CredencialArcaPublica } from "@/lib/fiscal/config";
import type { AmbienteArca } from "@/lib/fiscal/contexto";
import { mensajeCodigoErrorFiscalUsuario } from "@/lib/fiscal/error-usuario";

export type EstadoVisualPadron = "NO_CONFIGURADO" | "FALTA_PROBAR" | "ACTIVO" | "PRUEBA_FALLIDA";

// El contrato público exige que el componente y su derivación de estado vivan juntos.
// eslint-disable-next-line react-refresh/only-export-components
export function estadoVisualPadron(credencial: CredencialArcaPublica): EstadoVisualPadron {
  if (!credencial.tiene_certificado) return "NO_CONFIGURADO";
  if (credencial.padron_ultimo_error_codigo) return "PRUEBA_FALLIDA";
  if (credencial.padron_validacion_activa && credencial.padron_probado_at) return "ACTIVO";
  return "FALTA_PROBAR";
}

const etiquetasEstado: Record<EstadoVisualPadron, string> = {
  NO_CONFIGURADO: "No configurado",
  FALTA_PROBAR: "Falta probar",
  ACTIVO: "Activo",
  PRUEBA_FALLIDA: "Prueba fallida",
};

export function PadronArcaConfig(props: {
  emisorId: string;
  credencial: CredencialArcaPublica;
  mockMode: boolean;
  probando: boolean;
  onProbar(input: { emisor_id: string; ambiente: AmbienteArca }): void;
}): ReactElement {
  const { emisorId, credencial, mockMode, probando, onProbar } = props;
  const estado = estadoVisualPadron(credencial);
  const sinCertificado = !credencial.tiene_certificado;
  const deshabilitado = mockMode || sinCertificado || probando;
  const tituloId = `padron-arca-${emisorId}-${credencial.ambiente}`;
  const ayudaId = `${tituloId}-ayuda`;

  return (
    <section
      aria-labelledby={tituloId}
      className={`rounded-md border p-3 ${
        estado === "PRUEBA_FALLIDA" ? "border-warning/40 bg-warning/5" : "border-border bg-muted/20"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id={tituloId} className="text-sm font-medium">
              Padrón de receptores
            </h4>
            <Badge
              role="status"
              variant={estado === "PRUEBA_FALLIDA" ? "destructive" : "outline"}
              className={estado === "ACTIVO" ? "border-success/40 text-success" : undefined}
            >
              {estado === "ACTIVO" ? (
                <CheckCircle2 aria-hidden="true" className="mr-1 h-3 w-3" />
              ) : estado === "PRUEBA_FALLIDA" ? (
                <AlertTriangle aria-hidden="true" className="mr-1 h-3 w-3" />
              ) : estado === "NO_CONFIGURADO" ? (
                <ShieldX aria-hidden="true" className="mr-1 h-3 w-3" />
              ) : (
                <CircleDashed aria-hidden="true" className="mr-1 h-3 w-3" />
              )}
              {etiquetasEstado[estado]}
            </Badge>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Asociá el certificado actual al servicio ws_sr_constancia_inscripcion en ARCA. La prueba
            consulta el CUIT del propio emisor y recién entonces activa la validación.
          </p>

          {estado === "NO_CONFIGURADO" ? (
            <p id={ayudaId} className="text-xs text-muted-foreground">
              Cargá el certificado de este ambiente para poder probar el padrón.
            </p>
          ) : estado === "ACTIVO" ? (
            <p id={ayudaId} className="text-xs text-success">
              ARCA verificó el CUIT del emisor. La validación de receptores está activa.
            </p>
          ) : estado === "PRUEBA_FALLIDA" && credencial.padron_ultimo_error_codigo ? (
            <p id={ayudaId} role="alert" className="text-xs text-destructive">
              {mensajeCodigoErrorFiscalUsuario(credencial.padron_ultimo_error_codigo)}
            </p>
          ) : mockMode ? (
            <p id={ayudaId} className="text-xs text-muted-foreground">
              Desactivá el modo simulado para ejecutar una prueba real con ARCA.
            </p>
          ) : (
            <p id={ayudaId} className="text-xs text-muted-foreground">
              Probá el servicio para activar la validación de receptores en este ambiente.
            </p>
          )}
        </div>

        <Button
          type="button"
          size="sm"
          variant={estado === "ACTIVO" ? "outline" : "default"}
          className="w-full shrink-0 sm:w-auto"
          disabled={deshabilitado}
          aria-busy={probando}
          aria-describedby={ayudaId}
          onClick={() =>
            onProbar({
              emisor_id: emisorId,
              ambiente: credencial.ambiente,
            })
          }
        >
          {probando ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Probar y activar padrón
        </Button>
      </div>
    </section>
  );
}
