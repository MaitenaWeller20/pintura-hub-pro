import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/app/section-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertTriangle, Loader2, Upload, Trash2 } from "lucide-react";
import { listarEmisores, guardarEmisor, guardarContactoSucursal } from "@/lib/emisores.functions";
import { guardarModalidadFacturaA } from "@/lib/fiscal/config.functions";
import { QUERY_KEY_CONFIG_FISCAL_ADMIN } from "@/lib/fiscal/config";
import { mensajeErrorFiscal } from "@/lib/fiscal/error-usuario";

/**
 * Los datos que salen en el encabezado de presupuestos y remitos.
 *
 * Están acá y no en una pantalla propia de Sucursales porque esa pantalla no
 * existe, y porque son de la misma familia que la configuración fiscal: los toca
 * un admin, de vez en cuando.
 *
 * Son DOS personas jurídicas —una SRL y una SAS—, cada una con su local. Por eso
 * se editan por emisor y no como una configuración global: ver la migración
 * 20260814120000.
 */

const TOPE_LOGO = 100 * 1024;
const LADO_MAX = 1000;

/**
 * Pasa el archivo a data URL, reescalándolo si hace falta.
 *
 * El reescalado no es cosmético: lo que hace pesado al PDF no es el peso del
 * archivo sino los píxeles, y una foto de celular de 4000px metida como logo
 * infla cada comprobante. Se achica acá, en el navegador, antes de guardar.
 */
async function aDataUrl(file: File): Promise<string> {
  const original = await new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(new Error("No se pudo leer el archivo."));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("Ese archivo no es una imagen que se pueda abrir."));
    i.src = original;
  });

  const escala = Math.min(1, LADO_MAX / Math.max(img.width, img.height));
  if (escala === 1 && original.length <= TOPE_LOGO) return original;

  const dibujar = (ancho: number, alto: number, fondoBlanco: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    // JPEG no tiene transparencia: sin pintar el fondo, lo transparente de un
    // logo PNG sale NEGRO. Se pinta blanco antes.
    if (ctx && fondoBlanco) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, ancho, alto);
    }
    ctx?.drawImage(img, 0, 0, ancho, alto);
    return canvas;
  };

  // Se prueba en PNG, achicando de a poco: un logo es texto y formas planas, así
  // que baja mucho de peso con poca pérdida de tamaño. Recién si ni al 40% entra
  // se pasa a JPEG, que sí pierde la transparencia.
  let ancho = Math.round(img.width * escala);
  let alto = Math.round(img.height * escala);
  for (let intento = 0; intento < 4; intento++) {
    const png = dibujar(ancho, alto, false).toDataURL("image/png");
    if (png.length <= TOPE_LOGO) return png;
    ancho = Math.round(ancho * 0.8);
    alto = Math.round(alto * 0.8);
  }

  const jpeg = dibujar(ancho, alto, true).toDataURL("image/jpeg", 0.85);
  if (jpeg.length > TOPE_LOGO) {
    throw new Error("El logo es muy pesado incluso achicado. Probá con uno más simple.");
  }
  return jpeg;
}

export function EmisoresConfig({ esAdmin = false }: { esAdmin?: boolean }) {
  const qc = useQueryClient();
  const traer = useServerFn(listarEmisores);
  const grabarEmisor = useServerFn(guardarEmisor);
  const grabarSucursal = useServerFn(guardarContactoSucursal);
  const grabarModalidadA = useServerFn(guardarModalidadFacturaA);
  const [subiendo, setSubiendo] = useState<string | null>(null);

  const {
    data: emisores = [],
    isLoading,
    error: errorEmisores,
  } = useQuery({
    queryKey: ["emisores"],
    queryFn: () => traer(),
  });

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["emisores"] });
    qc.invalidateQueries({ queryKey: QUERY_KEY_CONFIG_FISCAL_ADMIN });
    toast.success("Guardado");
  };

  const mEmisor = useMutation({
    mutationFn: (d: any) => grabarEmisor({ data: d }),
    onSuccess: refrescar,
    onError: (error: unknown) => toast.error(mensajeErrorFiscal(error, "CONFIGURACION")),
  });
  const mSucursal = useMutation({
    mutationFn: (d: any) => grabarSucursal({ data: d }),
    onSuccess: refrescar,
    onError: (error: unknown) => toast.error(mensajeErrorFiscal(error, "CONFIGURACION")),
  });
  const mModalidadA = useMutation({
    mutationFn: (d: {
      emisor_id: string;
      modalidad: "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA";
      evidencia: string;
      revalidar_at: string;
    }) => grabarModalidadA({ data: d }),
    onSuccess: refrescar,
    onError: (error: unknown) => toast.error(mensajeErrorFiscal(error, "CONFIGURACION")),
  });

  const subirLogo = async (emisorId: string, file: File) => {
    setSubiendo(emisorId);
    try {
      const logo = await aDataUrl(file);
      const em = emisores.find((e: any) => e.id === emisorId);
      await mEmisor.mutateAsync({ ...soloCampos(em), id: emisorId, logo });
    } catch (error: unknown) {
      toast.error(mensajeErrorFiscal(error, "CONFIGURACION"));
    } finally {
      setSubiendo(null);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando…</p>;
  if (errorEmisores) {
    return (
      <SectionCard title="Identidad fiscal e impresos">
        <p role="alert" className="text-sm font-medium text-destructive">
          {mensajeErrorFiscal(errorEmisores, "CONFIGURACION")}
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Identidad fiscal e impresos">
      <p className="mb-4 text-sm text-muted-foreground">
        Estos datos identifican a cada empresa en presupuestos, remitos y facturas nuevas. Al emitir
        una factura se congelan: una reimpresión posterior no cambia aunque edites esta ficha.
      </p>

      <div className="space-y-6">
        {emisores.map((e: any) => (
          <div key={e.id} className="rounded-lg border border-border p-4">
            <FormEmisor
              emisor={e}
              onGuardar={(d) => mEmisor.mutate(d)}
              guardando={mEmisor.isPending}
            />

            <ModalidadFacturaAEditor
              emisor={e}
              esAdmin={esAdmin}
              guardando={mModalidadA.isPending}
              onGuardar={(d) => mModalidadA.mutate(d)}
            />

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Label className="text-xs text-muted-foreground">Logo</Label>
              {e.logo ? (
                <img
                  src={e.logo}
                  alt=""
                  className="h-10 w-auto rounded border border-border bg-white p-1"
                />
              ) : (
                <span className="text-xs text-muted-foreground">sin logo</span>
              )}
              <Button size="sm" variant="outline" asChild disabled={subiendo === e.id}>
                <label className="cursor-pointer">
                  {subiendo === e.id ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Upload className="h-3.5 w-3.5 mr-1" />
                  )}
                  Subir
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    className="hidden"
                    onChange={(ev) => {
                      const f = ev.target.files?.[0];
                      ev.target.value = ""; // para poder volver a elegir el mismo
                      if (f) subirLogo(e.id, f);
                    }}
                  />
                </label>
              </Button>
              {e.logo && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => mEmisor.mutate({ ...soloCampos(e), id: e.id, logo: null })}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              )}
              <span className="text-xs text-muted-foreground">PNG o JPEG, hasta 100 KB</span>
            </div>

            {(e.sucursales ?? []).map((s: any) => (
              <FormSucursal
                key={s.id}
                sucursal={s}
                onGuardar={(d) => mSucursal.mutate(d)}
                guardando={mSucursal.isPending}
              />
            ))}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

type EmisorModalidadA = {
  id: string;
  factura_a_modalidad: "DESCONOCIDA" | "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA";
  factura_a_confirmada_at: string | null;
  factura_a_revalidar_at: string | null;
  factura_a_evidencia: string | null;
};

const etiquetaModalidadA = (modalidad: EmisorModalidadA["factura_a_modalidad"]) =>
  modalidad === "ESTANDAR_CONFIRMADA"
    ? "Factura A estándar confirmada"
    : modalidad === "NO_SOPORTADA"
      ? "Factura A estándar no soportada"
      : "Factura A estándar sin confirmar";

/**
 * La evidencia completa y el formulario sólo existen para administradores.
 * El fallback no incluye el texto guardado, aunque alguien reutilice este
 * componente fuera de la ruta protegida.
 */
export function ModalidadFacturaAEditor({
  emisor,
  esAdmin,
  guardando,
  onGuardar,
}: {
  emisor: EmisorModalidadA;
  esAdmin: boolean;
  guardando: boolean;
  onGuardar: (d: {
    emisor_id: string;
    modalidad: "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA";
    evidencia: string;
    revalidar_at: string;
  }) => void;
}) {
  const modalidadInicial =
    emisor.factura_a_modalidad === "NO_SOPORTADA" ? "NO_SOPORTADA" : "ESTANDAR_CONFIRMADA";
  const [modalidad, setModalidad] = useState<"ESTANDAR_CONFIRMADA" | "NO_SOPORTADA">(
    modalidadInicial,
  );
  const [evidencia, setEvidencia] = useState(emisor.factura_a_evidencia ?? "");
  const [revalidarAt, setRevalidarAt] = useState(emisor.factura_a_revalidar_at ?? "");

  if (!esAdmin) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        {etiquetaModalidadA(emisor.factura_a_modalidad)}
      </p>
    );
  }

  const valido = evidencia.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(revalidarAt);
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div>
        <p className="text-sm font-medium">{etiquetaModalidadA(emisor.factura_a_modalidad)}</p>
        {emisor.factura_a_confirmada_at && (
          <p className="text-xs text-muted-foreground">
            Última decisión: {new Date(emisor.factura_a_confirmada_at).toLocaleDateString("es-AR")}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`modalidad-a-${emisor.id}`}>Modalidad administrativa</Label>
          <Select
            value={modalidad}
            onValueChange={(valor) => setModalidad(valor as "ESTANDAR_CONFIRMADA" | "NO_SOPORTADA")}
          >
            <SelectTrigger id={`modalidad-a-${emisor.id}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ESTANDAR_CONFIRMADA">A estándar confirmada</SelectItem>
              <SelectItem value="NO_SOPORTADA">No soportada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor={`revalidar-a-${emisor.id}`}>Revalidar el</Label>
          <Input
            id={`revalidar-a-${emisor.id}`}
            type="date"
            value={revalidarAt}
            onChange={(evento) => setRevalidarAt(evento.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={`evidencia-a-${emisor.id}`}>Fuente o evidencia</Label>
          <Input
            id={`evidencia-a-${emisor.id}`}
            value={evidencia}
            maxLength={1_000}
            onChange={(evento) => setEvidencia(evento.target.value)}
            placeholder="Ej.: confirmación de la contadora y fecha"
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={!valido || guardando}
          onClick={() =>
            onGuardar({
              emisor_id: emisor.id,
              modalidad,
              evidencia,
              revalidar_at: revalidarAt,
            })
          }
        >
          {guardando && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Confirmar modalidad A
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        La prueba técnica sólo informa acceso a secuencia A/B; nunca confirma esta modalidad.
      </p>
    </div>
  );
}

/** Sólo los campos que acepta guardarEmisor: el resto lo rechaza el validador. */
const soloCampos = (e: any) => ({
  razon_social: e?.razon_social ?? "",
  nombre_fantasia: e?.nombre_fantasia ?? null,
  cuit: e?.cuit ?? null,
  domicilio_fiscal: e?.domicilio_fiscal ?? null,
  condicion_iva: e?.condicion_iva ?? "RESPONSABLE_INSCRIPTO",
  ingresos_brutos: e?.ingresos_brutos ?? null,
  inicio_actividades: e?.inicio_actividades ?? null,
});

function FormEmisor({
  emisor,
  onGuardar,
  guardando,
}: {
  emisor: any;
  onGuardar: (d: any) => void;
  guardando: boolean;
}) {
  const [f, setF] = useState(soloCampos(emisor));
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const guardar = () =>
    onGuardar({
      ...f,
      id: emisor.id,
      nombre_fantasia: f.nombre_fantasia || null,
      cuit: f.cuit || null,
      domicilio_fiscal: f.domicilio_fiscal || null,
      ingresos_brutos: f.ingresos_brutos || null,
      inicio_actividades: f.inicio_actividades || null,
    });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Label htmlFor={`razon-${emisor.id}`}>Razón social *</Label>
        <Input
          id={`razon-${emisor.id}`}
          value={f.razon_social}
          onChange={(e) => set("razon_social", e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor={`fantasia-${emisor.id}`}>Nombre de fantasía</Label>
        <Input
          id={`fantasia-${emisor.id}`}
          value={f.nombre_fantasia ?? ""}
          onChange={(e) => set("nombre_fantasia", e.target.value)}
          placeholder="CasaForma"
        />
      </div>
      <div>
        <Label htmlFor={`cuit-${emisor.id}`}>CUIT</Label>
        <Input
          id={`cuit-${emisor.id}`}
          value={f.cuit ?? ""}
          onChange={(e) => set("cuit", e.target.value)}
          placeholder="30-00000000-0"
        />
      </div>
      <div>
        <Label htmlFor={`iva-${emisor.id}`}>Condición de IVA</Label>
        <Select
          value={f.condicion_iva ?? "RESPONSABLE_INSCRIPTO"}
          onValueChange={(v) => set("condicion_iva", v)}
        >
          <SelectTrigger id={`iva-${emisor.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</SelectItem>
            <SelectItem value="MONOTRIBUTO">Monotributo</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`inicio-${emisor.id}`}>Inicio de actividades</Label>
        <Input
          id={`inicio-${emisor.id}`}
          type="date"
          value={f.inicio_actividades ?? ""}
          onChange={(e) => set("inicio_actividades", e.target.value)}
        />
        {!f.inicio_actividades && (
          <p className="mt-1 flex items-center gap-1 text-xs text-warning">
            <AlertTriangle className="h-3 w-3" /> Confirmar con la contadora; no se completa por
            aproximación.
          </p>
        )}
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`domicilio-${emisor.id}`}>Domicilio fiscal</Label>
        <Input
          id={`domicilio-${emisor.id}`}
          value={f.domicilio_fiscal ?? ""}
          onChange={(e) => set("domicilio_fiscal", e.target.value)}
        />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`iibb-${emisor.id}`}>Ingresos Brutos</Label>
        <Input
          id={`iibb-${emisor.id}`}
          value={f.ingresos_brutos ?? ""}
          onChange={(e) => set("ingresos_brutos", e.target.value)}
        />
      </div>
      <div className="sm:col-span-2 flex justify-end">
        <Button disabled={guardando} onClick={guardar}>
          {guardando && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Guardar empresa
        </Button>
      </div>
    </div>
  );
}

function FormSucursal({
  sucursal,
  onGuardar,
  guardando,
}: {
  sucursal: any;
  onGuardar: (d: any) => void;
  guardando: boolean;
}) {
  const [f, setF] = useState({
    direccion: sucursal.direccion ?? "",
    telefono: sucursal.telefono ?? "",
  });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  return (
    <div
      data-testid="contacto-sucursal"
      className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-[1fr_1fr_auto]"
    >
      <div className="sm:col-span-3">
        <p className="text-xs font-medium text-muted-foreground">{sucursal.nombre}</p>
      </div>
      <div>
        <Label>Dirección</Label>
        <Input value={f.direccion} onChange={(e) => set("direccion", e.target.value)} />
      </div>
      <div>
        <Label>Celular</Label>
        <Input
          value={f.telefono}
          onChange={(e) => set("telefono", e.target.value)}
          placeholder="3512146766"
        />
      </div>
      <div className="flex items-end">
        <Button
          variant="outline"
          disabled={guardando}
          onClick={() => onGuardar({ ...f, id: sucursal.id })}
        >
          {guardando && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Guardar
        </Button>
      </div>
    </div>
  );
}
