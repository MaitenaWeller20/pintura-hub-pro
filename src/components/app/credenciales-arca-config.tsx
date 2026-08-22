import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileKey2,
  Loader2,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/app/section-card";
import { fmtDate } from "@/lib/format";
import {
  generarCsr,
  guardarCertificado,
  guardarHabilitacionCredencial,
  guardarPuntoVenta,
  obtenerConfigFiscal,
  probarConexionAfip,
  type ConfigFiscalPublica,
} from "@/lib/fiscal/config.functions";
import type { AmbienteArca } from "@/lib/fiscal/contexto";
import { QUERY_KEY_CONFIG_FISCAL_ADMIN } from "@/lib/fiscal/config";

type Emisor = ConfigFiscalPublica["emisores"][number];
type Sucursal = Emisor["sucursales"][number];
type Credencial = Emisor["credenciales"][number];

const ambienteLabel: Record<AmbienteArca, string> = {
  HOMOLOGACION: "homologación",
  PRODUCCION: "producción",
};

function cuitLegible(cuit: string | null): string {
  const n = (cuit ?? "").replace(/\D/g, "");
  return n.length === 11 ? `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}` : "CUIT pendiente";
}

const pvLegible = (numero: number) => String(numero).padStart(5, "0");

function descargarCsr(csr: string, alias: string, cuit: string | null, ambiente: AmbienteArca) {
  const blob = new Blob([csr], { type: "application/pkcs10" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = `${alias}-${cuit ?? "sin-cuit"}-${ambiente.toLowerCase()}.csr`;
  enlace.click();
  URL.revokeObjectURL(url);
}

function EstadoCredencial({ credencial }: { credencial: Credencial }) {
  if (credencial.habilitada) {
    return <Badge className="bg-success text-success-foreground">Habilitada</Badge>;
  }
  if (credencial.tiene_certificado && credencial.probada_at) {
    return <Badge variant="outline">Lista, deshabilitada</Badge>;
  }
  if (credencial.tiene_certificado) {
    return <Badge variant="outline">Falta probar conexión</Badge>;
  }
  if (credencial.tiene_clave) {
    return <Badge variant="outline">Esperando certificado</Badge>;
  }
  return <Badge variant="outline">Falta generar CSR</Badge>;
}

export function CredencialesArcaConfig() {
  const qc = useQueryClient();
  const cargar = useServerFn(obtenerConfigFiscal);
  const guardarPv = useServerFn(guardarPuntoVenta);
  const generar = useServerFn(generarCsr);
  const guardarCert = useServerFn(guardarCertificado);
  const probar = useServerFn(probarConexionAfip);
  const habilitar = useServerFn(guardarHabilitacionCredencial);

  const { data, isLoading, error } = useQuery({
    queryKey: QUERY_KEY_CONFIG_FISCAL_ADMIN,
    queryFn: () => cargar(),
  });

  const refrescar = () => qc.invalidateQueries({ queryKey: QUERY_KEY_CONFIG_FISCAL_ADMIN });

  const mPv = useMutation({
    mutationFn: (entrada: {
      sucursal_id: string;
      numero: number;
      modo: AmbienteArca;
      activo: boolean;
    }) => guardarPv({ data: entrada }),
    onSuccess: () => {
      toast.success("Punto de venta guardado");
      refrescar();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const mCsr = useMutation({
    mutationFn: (entrada: { emisor: Emisor; ambiente: AmbienteArca }) =>
      generar({ data: { emisor_id: entrada.emisor.id, ambiente: entrada.ambiente } }).then((r) => ({
        ...r,
        cuit: entrada.emisor.cuit,
      })),
    onSuccess: (r) => {
      descargarCsr(r.csr, r.alias, r.cuit, r.ambiente);
      toast.success("CSR descargado. Podés enviárselo a la contadora.");
      refrescar();
    },
    onError: (e: Error) => toast.error(e.message, { duration: 8_000 }),
  });

  const mCert = useMutation({
    mutationFn: (entrada: { emisor_id: string; ambiente: AmbienteArca; pem: string }) =>
      guardarCert({ data: entrada }),
    onSuccess: (r) => {
      toast.success(`Certificado cargado. Vence el ${fmtDate(r.vence)}.`);
      refrescar();
    },
    onError: (e: Error) => toast.error(e.message, { duration: 10_000 }),
  });

  const mPrueba = useMutation({
    mutationFn: (sucursalId: string) => probar({ data: { sucursal_id: sucursalId } }),
    onSuccess: (r) => {
      const mensaje = `Acceso a secuencia A/B: A ${r.secuencia_a.ultimo}, B ${r.secuencia_b.ultimo}.`;
      if (data?.mock_mode) toast.warning(`Modo simulado. ${mensaje}`);
      else toast.success(mensaje);
      refrescar();
    },
    onError: (e: Error) => toast.error(e.message, { duration: 10_000 }),
  });

  const mHabilitar = useMutation({
    mutationFn: (entrada: { emisor_id: string; ambiente: AmbienteArca; habilitada: boolean }) =>
      habilitar({ data: entrada }),
    onSuccess: (r) => {
      toast.success(r.habilitada ? "Credencial habilitada" : "Credencial deshabilitada");
      refrescar();
    },
    onError: (e: Error) => toast.error(e.message, { duration: 8_000 }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando ARCA…</p>;
  if (error || !data) {
    return (
      <SectionCard>
        <p className="text-sm text-destructive">No se pudo cargar la configuración de ARCA.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="ARCA por empresa" className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p>
          {data.mock_mode ? (
            <>
              <strong>Modo simulado activo.</strong> Ninguna prueba marca credenciales como
              verificadas y no se pueden habilitar hasta apagarlo.
            </>
          ) : (
            <>Cada empresa firma con su propio CUIT, certificado y punto de venta.</>
          )}
        </p>
      </div>

      <div className="space-y-5">
        {data.emisores.map((emisor) => (
          <article
            key={emisor.id}
            data-testid={`arca-emisor-${emisor.cuit ?? emisor.id}`}
            className="overflow-hidden rounded-xl border border-border bg-card"
          >
            <header className="flex flex-col gap-3 border-b border-border bg-muted/30 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="font-mono text-xs tracking-wide text-muted-foreground">
                  {cuitLegible(emisor.cuit)}
                </p>
                <h3 className="mt-1 text-base font-semibold">{emisor.razon_social}</h3>
                <p className="text-sm text-muted-foreground">
                  {emisor.nombre_fantasia || "Sin nombre de fantasía"}
                </p>
              </div>
              {emisor.sucursales.some((s) => s.punto_venta?.activo) ? (
                <Badge variant="outline" className="w-fit">
                  Configuración en curso
                </Badge>
              ) : (
                <Badge variant="destructive" className="w-fit">
                  Bloqueada: PV inactivo
                </Badge>
              )}
            </header>

            <div className="space-y-5 p-4">
              {!emisor.inicio_actividades && (
                <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  Falta confirmar el inicio de actividades con la contadora. No se puede emitir
                  hasta cargarlo.
                </div>
              )}

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sucursales y puntos de venta
                </p>
                {emisor.sucursales.map((sucursal) => (
                  <PuntoVentaEditor
                    key={`${sucursal.id}-${sucursal.punto_venta?.numero}-${sucursal.punto_venta?.modo}-${sucursal.punto_venta?.activo}`}
                    sucursal={sucursal}
                    guardando={mPv.isPending}
                    probando={mPrueba.isPending}
                    onGuardar={(entrada) => mPv.mutate(entrada)}
                    onProbar={() => mPrueba.mutate(sucursal.id)}
                  />
                ))}
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Credenciales
                </p>
                {emisor.credenciales.map((credencial) => (
                  <CredencialEditor
                    key={credencial.ambiente}
                    emisor={emisor}
                    credencial={credencial}
                    mockMode={data.mock_mode}
                    generando={mCsr.isPending}
                    subiendo={mCert.isPending}
                    cambiandoEstado={mHabilitar.isPending}
                    onCsr={(ambiente) => mCsr.mutate({ emisor, ambiente })}
                    onCertificado={(ambiente, pem) =>
                      mCert.mutate({ emisor_id: emisor.id, ambiente, pem })
                    }
                    onHabilitar={(ambiente, habilitada) =>
                      mHabilitar.mutate({ emisor_id: emisor.id, ambiente, habilitada })
                    }
                  />
                ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </SectionCard>
  );
}

function PuntoVentaEditor({
  sucursal,
  guardando,
  probando,
  onGuardar,
  onProbar,
}: {
  sucursal: Sucursal;
  guardando: boolean;
  probando: boolean;
  onGuardar: (entrada: {
    sucursal_id: string;
    numero: number;
    modo: AmbienteArca;
    activo: boolean;
  }) => void;
  onProbar: () => void;
}) {
  const pv = sucursal.punto_venta;
  const [numero, setNumero] = useState(pv ? String(pv.numero) : "");
  const [modo, setModo] = useState<AmbienteArca>(pv?.modo ?? "HOMOLOGACION");
  const [activo, setActivo] = useState(pv?.activo ?? false);
  const valido = /^\d+$/.test(numero.trim()) && Number(numero) > 0;
  const cambio = !pv || String(pv.numero) !== numero || pv.modo !== modo || pv.activo !== activo;
  const idNumero = `pv-numero-${sucursal.id}`;
  const idActivo = `pv-activo-${sucursal.id}`;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{sucursal.nombre}</p>
          <p className="font-mono text-xs text-muted-foreground">
            PV {valido ? pvLegible(Number(numero)) : "-----"}
          </p>
        </div>
        {activo ? (
          <Badge variant="outline">Activa para ARCA</Badge>
        ) : (
          <Badge variant="destructive">Inactiva para ARCA</Badge>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(180px,0.7fr)_minmax(220px,1fr)_auto]">
        <div>
          <Label htmlFor={idNumero}>Número de punto de venta</Label>
          <Input
            id={idNumero}
            inputMode="numeric"
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
          />
          {!valido && <p className="mt-1 text-xs text-destructive">Ingresá un entero mayor a 0.</p>}
        </div>
        <div>
          <Label htmlFor={`pv-modo-${sucursal.id}`}>Ambiente del PV</Label>
          <Select value={modo} onValueChange={(v) => setModo(v as AmbienteArca)}>
            <SelectTrigger id={`pv-modo-${sucursal.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="HOMOLOGACION">Homologación (prueba)</SelectItem>
              <SelectItem value="PRODUCCION">Producción (legal)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <Button
            size="sm"
            disabled={!valido || !cambio || guardando}
            onClick={() =>
              onGuardar({
                sucursal_id: sucursal.id,
                numero: Number(numero),
                modo,
                activo,
              })
            }
          >
            {guardando && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Guardar PV
          </Button>
          <Button
            size="icon"
            variant="outline"
            title="Probar acceso a secuencia A/B"
            aria-label="Probar acceso a secuencia A/B"
            disabled={!pv?.activo || cambio || probando}
            onClick={onProbar}
          >
            {probando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Switch id={idActivo} checked={activo} onCheckedChange={setActivo} />
        <Label htmlFor={idActivo} className="font-normal">
          Sucursal habilitada para facturación electrónica
        </Label>
      </div>
    </div>
  );
}

function CredencialEditor({
  emisor,
  credencial,
  mockMode,
  generando,
  subiendo,
  cambiandoEstado,
  onCsr,
  onCertificado,
  onHabilitar,
}: {
  emisor: Emisor;
  credencial: Credencial;
  mockMode: boolean;
  generando: boolean;
  subiendo: boolean;
  cambiandoEstado: boolean;
  onCsr: (ambiente: AmbienteArca) => void;
  onCertificado: (ambiente: AmbienteArca, pem: string) => void;
  onHabilitar: (ambiente: AmbienteArca, habilitada: boolean) => void;
}) {
  const etiqueta = ambienteLabel[credencial.ambiente];
  const pvConfirmado = emisor.sucursales.some(
    (sucursal) => sucursal.punto_venta?.activo && sucursal.punto_venta.modo === credencial.ambiente,
  );
  const puedeGenerar = Boolean(emisor.cuit && emisor.razon_social && pvConfirmado);
  const accionCsr = credencial.tiene_clave
    ? `Descargar CSR de ${etiqueta}`
    : `Generar CSR de ${etiqueta}`;

  return (
    <div className="grid gap-3 rounded-lg border border-border p-3 lg:grid-cols-[minmax(180px,0.6fr)_1fr]">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium capitalize">{etiqueta}</p>
          <EstadoCredencial credencial={credencial} />
        </div>
        {credencial.cert_vence_at && (
          <p className="text-xs text-muted-foreground">
            Certificado hasta {fmtDate(credencial.cert_vence_at)}
          </p>
        )}
        {credencial.probada_at && (
          <p className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="h-3 w-3" /> Conexión real verificada
          </p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {!credencial.tiene_certificado && (
            <Button
              size="sm"
              variant="outline"
              disabled={!puedeGenerar || generando}
              onClick={() => onCsr(credencial.ambiente)}
            >
              {generando ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : credencial.tiene_clave ? (
                <Download className="mr-1 h-3.5 w-3.5" />
              ) : (
                <FileKey2 className="mr-1 h-3.5 w-3.5" />
              )}
              {accionCsr}
            </Button>
          )}
          {credencial.tiene_certificado && (
            <Button
              size="sm"
              variant={credencial.habilitada ? "outline" : "default"}
              disabled={
                cambiandoEstado || (!credencial.habilitada && (mockMode || !credencial.probada_at))
              }
              onClick={() => onHabilitar(credencial.ambiente, !credencial.habilitada)}
            >
              <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              {credencial.habilitada ? `Deshabilitar ${etiqueta}` : `Habilitar ${etiqueta}`}
            </Button>
          )}
        </div>

        {!puedeGenerar && !credencial.tiene_clave && (
          <p className="text-xs text-muted-foreground">
            Confirmá CUIT, razón social y un PV activo de {etiqueta} para generar este CSR.
          </p>
        )}

        {credencial.tiene_clave && !credencial.tiene_certificado && (
          <div>
            <Label htmlFor={`cert-${emisor.id}-${credencial.ambiente}`}>
              Cargar certificado de {etiqueta}
            </Label>
            <Input
              id={`cert-${emisor.id}-${credencial.ambiente}`}
              type="file"
              accept=".crt,.cer,.pem,text/plain,application/x-x509-ca-cert"
              disabled={subiendo}
              onChange={async (evento) => {
                const archivo = evento.target.files?.[0];
                evento.target.value = "";
                if (!archivo) return;
                try {
                  onCertificado(credencial.ambiente, await archivo.text());
                } catch {
                  toast.error("No se pudo leer el certificado.");
                }
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
