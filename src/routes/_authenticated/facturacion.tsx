/**
 * Configuración de facturación electrónica (AFIP/ARCA).
 *
 * Es un trámite de varias etapas, no un formulario. La pantalla acompaña el
 * proceso real:
 *   1. Datos fiscales del emisor (CUIT, razón social, condición de IVA)
 *   2. Punto de venta por sucursal (hay que darlos de alta en AFIP como WSFE)
 *   3. Generar el CSR -> el contador lo sube a AFIP -> devuelve el .crt
 *   4. Subir el .crt y probar la conexión
 *   5. Recién ahí se pasa a producción
 */
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/app/page-header";
import { SectionCard } from "@/components/app/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  FileCheck2, ShieldCheck, AlertTriangle, Loader2, Copy, KeyRound, Plug, Trash2,
} from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import {
  obtenerConfigFiscal, guardarConfigFiscal, guardarPuntoVenta,
  generarCsr, guardarCertificado, borrarCertificado, probarConexionAfip,
} from "@/lib/fiscal.functions";
import { fmtDate } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/facturacion")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/auth" });
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", data.user.id);
    if (!roles?.some((r) => r.role === "admin")) throw redirect({ to: "/" });
  },
  component: FacturacionPage,
});

function FacturacionPage() {
  const qc = useQueryClient();
  const cargar = useServerFn(obtenerConfigFiscal);
  const { data: cfg, isLoading } = useQuery({ queryKey: ["fiscal-config"], queryFn: () => cargar() });

  const invalidar = () => qc.invalidateQueries({ queryKey: ["fiscal-config"] });

  if (isLoading || !cfg) {
    return <div className="text-muted-foreground">Cargando…</div>;
  }

  const listo = cfg.habilitada && cfg.tiene_certificado;

  return (
    <div className="space-y-4 max-w-4xl">
      <PageHeader
        title="Facturación electrónica"
        subtitle="Configuración de AFIP/ARCA para emitir comprobantes con validez legal."
      />

      <EstadoGeneral cfg={cfg} listo={listo} />

      <DatosEmisor cfg={cfg} onSaved={invalidar} />
      <PuntosVenta cfg={cfg} onSaved={invalidar} />
      <Certificado cfg={cfg} onSaved={invalidar} />
    </div>
  );
}

function EstadoGeneral({ cfg, listo }: { cfg: any; listo: boolean }) {
  const porVencer = cfg.dias_para_vencer !== null && cfg.dias_para_vencer < 30;

  return (
    <SectionCard className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {cfg.mock_mode ? (
          <Badge className="bg-warning text-warning-foreground gap-1">
            <AlertTriangle className="h-3 w-3" /> MODO SIMULADO
          </Badge>
        ) : listo ? (
          <Badge className="bg-success text-success-foreground gap-1">
            <ShieldCheck className="h-3 w-3" /> LISTO PARA FACTURAR
          </Badge>
        ) : (
          <Badge variant="outline">SIN CONFIGURAR</Badge>
        )}
        {cfg.puntos_venta?.some((p: any) => p.modo === "PRODUCCION") && (
          <Badge className="bg-destructive text-destructive-foreground">PRODUCCIÓN</Badge>
        )}
      </div>

      {cfg.mock_mode && (
        <p className="text-sm text-muted-foreground">
          El sistema genera un <strong>CAE simulado</strong> y no llama a AFIP. Sirve para operar y
          probar el circuito completo mientras el trámite del certificado está en curso.{" "}
          <strong>Los comprobantes NO tienen validez legal.</strong> Se apaga con la variable{" "}
          <code className="text-xs">INVOICING_MOCK_MODE=false</code>.
        </p>
      )}

      {porVencer && (
        <div className="flex items-start gap-2 p-3 rounded border border-destructive/40 bg-destructive/5 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div>
            <strong>El certificado vence en {cfg.dias_para_vencer} días</strong> ({fmtDate(cfg.cert_vence_at)}).
            Cuando venza, deja de poder facturarse. Hay que rehacer el trámite del CSR con AFIP.
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function DatosEmisor({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const guardar = useServerFn(guardarConfigFiscal);
  const [form, setForm] = useState({
    cuit: cfg.cuit ?? "",
    razon_social: cfg.razon_social ?? "",
    nombre_fantasia: cfg.nombre_fantasia ?? "",
    domicilio_fiscal: cfg.domicilio_fiscal ?? "",
    condicion_iva: cfg.condicion_iva ?? "RESPONSABLE_INSCRIPTO",
    inicio_actividades: cfg.inicio_actividades ?? "",
    habilitada: cfg.habilitada ?? false,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const m = useMutation({
    mutationFn: async () =>
      guardar({
        data: {
          ...form,
          inicio_actividades: form.inicio_actividades || null,
          nombre_fantasia: form.nombre_fantasia || null,
          domicilio_fiscal: form.domicilio_fiscal || null,
        },
      }),
    onSuccess: () => { toast.success("Datos fiscales guardados"); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <SectionCard title="1. Datos del emisor" className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>CUIT *</Label>
          <Input value={form.cuit} onChange={(e) => set("cuit", e.target.value)} placeholder="30712345678" />
        </div>
        <div>
          <Label>Condición de IVA *</Label>
          <Select value={form.condicion_iva} onValueChange={(v) => set("condicion_iva", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</SelectItem>
              <SelectItem value="MONOTRIBUTO">Monotributo</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground mt-1">
            Determina la letra: Monotributo emite <strong>C</strong>; Responsable Inscripto,{" "}
            <strong>A</strong> o <strong>B</strong> según el cliente.
          </p>
        </div>
        <div className="col-span-2">
          <Label>Razón social *</Label>
          <Input
            value={form.razon_social}
            onChange={(e) => set("razon_social", e.target.value)}
            placeholder="Nombre legal exacto, como figura en AFIP"
          />
        </div>
        <div>
          <Label>Nombre de fantasía</Label>
          <Input value={form.nombre_fantasia} onChange={(e) => set("nombre_fantasia", e.target.value)} placeholder="CasaForma" />
        </div>
        <div>
          <Label>Inicio de actividades</Label>
          <Input type="date" value={form.inicio_actividades} onChange={(e) => set("inicio_actividades", e.target.value)} />
        </div>
        <div className="col-span-2">
          <Label>Domicilio fiscal</Label>
          <Input value={form.domicilio_fiscal} onChange={(e) => set("domicilio_fiscal", e.target.value)} />
        </div>
      </div>

      <label className="flex items-center gap-3 text-sm border border-border rounded p-3 bg-muted/30">
        <Switch checked={form.habilitada} onCheckedChange={(v) => set("habilitada", v)} />
        <span>
          <strong>Facturación electrónica habilitada.</strong> Si está apagada, el sistema no emite
          comprobantes fiscales (los remitos y ventas internas siguen funcionando igual).
        </span>
      </label>

      <div className="flex justify-end">
        <Button onClick={() => m.mutate()} disabled={m.isPending}>
          {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Guardar
        </Button>
      </div>
    </SectionCard>
  );
}

function PuntosVenta({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const guardar = useServerFn(guardarPuntoVenta);
  const probar = useServerFn(probarConexionAfip);

  const m = useMutation({
    mutationFn: async (d: any) => guardar({ data: d }),
    onSuccess: () => { toast.success("Punto de venta guardado"); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: async (sucursal_id: string) => probar({ data: { sucursal_id } }),
    onSuccess: (r: any) => toast.success(r.mensaje),
    onError: (e: any) => toast.error(e.message, { duration: 8000 }),
  });

  return (
    <SectionCard title="2. Puntos de venta" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Cada sucursal necesita su propio punto de venta dado de alta en AFIP con el sistema{" "}
        <strong>"Web Services - Factura Electrónica - WSFE"</strong>. No sirve "Factura en Línea" ni
        "Controlador Fiscal". Poné acá el número que te asignó AFIP.
      </p>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Sucursal</TableHead>
            <TableHead>N° punto de venta</TableHead>
            <TableHead>Ambiente</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {(cfg.puntos_venta ?? []).map((pv: any) => (
            <FilaPv key={pv.id} pv={pv} onSave={(d: any) => m.mutate(d)} onTest={() => test.mutate(pv.sucursal_id)} testing={test.isPending} />
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}

function FilaPv({ pv, onSave, onTest, testing }: any) {
  const [numero, setNumero] = useState(String(pv.numero));
  const [modo, setModo] = useState(pv.modo);
  const cambio = String(pv.numero) !== numero || pv.modo !== modo;

  return (
    <TableRow>
      <TableCell className="font-medium">{pv.sucursal?.nombre}</TableCell>
      <TableCell>
        <Input className="h-8 w-24" value={numero} onChange={(e) => setNumero(e.target.value)} />
      </TableCell>
      <TableCell>
        <Select value={modo} onValueChange={setModo}>
          <SelectTrigger className="h-8 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="HOMOLOGACION">Homologación (prueba)</SelectItem>
            <SelectItem value="PRODUCCION">Producción (legal)</SelectItem>
          </SelectContent>
        </Select>
        {modo === "PRODUCCION" && (
          <p className="text-[11px] text-destructive mt-1">
            Los comprobantes van a tener validez legal ante AFIP.
          </p>
        )}
      </TableCell>
      <TableCell className="flex gap-1">
        <Button
          size="sm"
          variant={cambio ? "default" : "outline"}
          disabled={!cambio}
          onClick={() => onSave({ sucursal_id: pv.sucursal_id, numero: Number(numero), modo })}
        >
          Guardar
        </Button>
        <Button size="sm" variant="ghost" onClick={onTest} disabled={testing}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function Certificado({ cfg, onSaved }: { cfg: any; onSaved: () => void }) {
  const genCsr = useServerFn(generarCsr);
  const guardarCert = useServerFn(guardarCertificado);
  const borrarCert = useServerFn(borrarCertificado);

  const [csr, setCsr] = useState<string | null>(null);
  const [pem, setPem] = useState("");

  const mCsr = useMutation({
    mutationFn: async () => genCsr(),
    onSuccess: (r: any) => { setCsr(r.csr); toast.success("CSR generado. Mandáselo al contador."); onSaved(); },
    onError: (e: any) => toast.error(e.message, { duration: 8000 }),
  });

  const mCert = useMutation({
    mutationFn: async () => guardarCert({ data: { pem } }),
    onSuccess: (r: any) => {
      toast.success(`Certificado cargado. Vence el ${fmtDate(r.vence)}.`);
      setPem(""); setCsr(null); onSaved();
    },
    onError: (e: any) => toast.error(e.message, { duration: 10000 }),
  });

  const mBorrar = useMutation({
    mutationFn: async () => borrarCert(),
    onSuccess: () => { toast.success("Certificado borrado"); onSaved(); },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <SectionCard title="3. Certificado digital" className="space-y-3">
      {cfg.tiene_certificado ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 rounded border border-success/40 bg-success/5 text-sm">
            <FileCheck2 className="h-4 w-4 text-success shrink-0" />
            <div className="flex-1">
              <strong>Certificado cargado.</strong> Vence el {fmtDate(cfg.cert_vence_at)}
              {cfg.dias_para_vencer !== null && ` (en ${cfg.dias_para_vencer} días)`}.
            </div>
            <Button size="sm" variant="ghost" onClick={() => mBorrar.mutate()} disabled={mBorrar.isPending}>
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Para renovarlo (los certificados de AFIP duran 2 años): borralo con la papelera y volvé a
            generar un CSR.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground space-y-2">
            <p>El trámite tiene tres partes:</p>
            <ol className="list-decimal list-inside space-y-1 ml-1">
              <li>Generás el CSR acá (la clave privada queda guardada cifrada y nunca sale del servidor).</li>
              <li>
                El contador lo sube a AFIP en <strong>"Administración de Certificados Digitales"</strong>{" "}
                y descarga el <code className="text-xs">.crt</code>. Después{" "}
                <strong className="text-foreground">tiene que autorizar ese certificado para el servicio WSFE</strong>{" "}
                en "Administrador de Relaciones" — este es el paso que más se olvida y sin él no funciona nada.
              </li>
              <li>Pegás el <code className="text-xs">.crt</code> acá abajo.</li>
            </ol>
          </div>

          {!csr ? (
            <Button onClick={() => mCsr.mutate()} disabled={mCsr.isPending || !cfg.cuit}>
              {mCsr.isPending ? (
                <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Generando clave RSA…</>
              ) : (
                <><KeyRound className="h-4 w-4 mr-1" /> Generar CSR</>
              )}
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>CSR — mandáselo al contador</Label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { navigator.clipboard.writeText(csr); toast.success("CSR copiado"); }}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
                </Button>
              </div>
              <Textarea readOnly value={csr} rows={6} className="font-mono text-[10px]" />
            </div>
          )}

          {!cfg.cuit && (
            <p className="text-xs text-warning">Cargá primero el CUIT del emisor (arriba).</p>
          )}

          {cfg.tiene_clave && (
            <div className="space-y-2 pt-2 border-t border-border">
              <Label>Certificado (.crt) que devolvió AFIP</Label>
              <Textarea
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                rows={5}
                className="font-mono text-[10px]"
                placeholder="-----BEGIN CERTIFICATE-----&#10;…&#10;-----END CERTIFICATE-----"
              />
              <Button onClick={() => mCert.mutate()} disabled={mCert.isPending || !pem.trim()}>
                {mCert.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />} Cargar certificado
              </Button>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
