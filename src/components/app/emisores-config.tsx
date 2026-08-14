import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/app/section-card";
import { Loader2, Upload, Trash2 } from "lucide-react";
import { listarEmisores, guardarEmisor, guardarContactoSucursal } from "@/lib/emisores.functions";

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

export function EmisoresConfig() {
  const qc = useQueryClient();
  const traer = useServerFn(listarEmisores);
  const grabarEmisor = useServerFn(guardarEmisor);
  const grabarSucursal = useServerFn(guardarContactoSucursal);
  const [subiendo, setSubiendo] = useState<string | null>(null);

  const { data: emisores = [], isLoading } = useQuery({
    queryKey: ["emisores"],
    queryFn: () => traer(),
  });

  const refrescar = () => {
    qc.invalidateQueries({ queryKey: ["emisores"] });
    toast.success("Guardado");
  };

  const mEmisor = useMutation({
    mutationFn: (d: any) => grabarEmisor({ data: d }),
    onSuccess: refrescar,
    onError: (e: any) => toast.error(e.message),
  });
  const mSucursal = useMutation({
    mutationFn: (d: any) => grabarSucursal({ data: d }),
    onSuccess: refrescar,
    onError: (e: any) => toast.error(e.message),
  });

  const subirLogo = async (emisorId: string, file: File) => {
    setSubiendo(emisorId);
    try {
      const logo = await aDataUrl(file);
      const em = emisores.find((e: any) => e.id === emisorId);
      await mEmisor.mutateAsync({ ...soloCampos(em), id: emisorId, logo });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSubiendo(null);
    }
  };

  if (isLoading) return <p className="text-sm text-muted-foreground">Cargando…</p>;

  return (
    <SectionCard title="Datos que salen en los impresos">
      <p className="mb-4 text-sm text-muted-foreground">
        Lo que aparece en el encabezado de los presupuestos y los remitos. La factura no usa esto:
        una factura ya emitida se reimprime con los datos que se le declararon a AFIP.
      </p>

      <div className="space-y-6">
        {emisores.map((e: any) => (
          <div key={e.id} className="rounded-lg border border-border p-4">
            <FormEmisor
              emisor={e}
              onGuardar={(d) => mEmisor.mutate(d)}
              guardando={mEmisor.isPending}
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

/** Sólo los campos que acepta guardarEmisor: el resto lo rechaza el validador. */
const soloCampos = (e: any) => ({
  razon_social: e?.razon_social ?? "",
  cuit: e?.cuit ?? null,
  domicilio_fiscal: e?.domicilio_fiscal ?? null,
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

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="sm:col-span-2">
        <Label>Razón social *</Label>
        <Input value={f.razon_social} onChange={(e) => set("razon_social", e.target.value)} />
      </div>
      <div>
        <Label>CUIT</Label>
        <Input
          value={f.cuit ?? ""}
          onChange={(e) => set("cuit", e.target.value)}
          placeholder="todavía sin cargar"
        />
      </div>
      <div className="sm:col-span-3">
        <Label>Domicilio fiscal</Label>
        <div className="flex gap-2">
          <Input
            value={f.domicilio_fiscal ?? ""}
            onChange={(e) => set("domicilio_fiscal", e.target.value)}
          />
          <Button disabled={guardando} onClick={() => onGuardar({ ...f, id: emisor.id })}>
            {guardando && <Loader2 className="h-4 w-4 mr-1 animate-spin" />} Guardar
          </Button>
        </div>
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
