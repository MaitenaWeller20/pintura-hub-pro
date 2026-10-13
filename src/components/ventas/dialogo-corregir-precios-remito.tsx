import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

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
import type { Database } from "@/integrations/supabase/types";
import { conIva, round2 } from "@/lib/fiscal/iva";
import { fmtMoney } from "@/lib/format";

type ItemVenta = Database["public"]["Tables"]["venta_items"]["Row"];

type ItemEditable = {
  id: string;
  codigo: string;
  descripcion: string;
  cantidad: number;
  ivaPorcentaje: number;
  precioFinal: number | null;
  descuentoPorcentaje: number | null;
  precioNetoOriginal: number;
  descuentoOriginal: number;
};

const MENSAJES_RPC_PERMITIDOS = [
  "Iniciá sesión nuevamente",
  "El perfil autenticado no existe o está inactivo",
  "Elegí el remito que querés corregir",
  "Volvé a abrir el remito",
  "Escribí un motivo concreto",
  "El motivo no puede superar",
  "Incluí todos los productos",
  "El remito supera el máximo",
  "El remito seleccionado no existe o no está disponible",
  "Sólo se pueden corregir precios",
  "No se puede corregir un remito anulado",
  "El remito debe estar vinculado",
  "El remito tiene pagos directos",
  "Otra persona corrigió este remito",
  "Cada producto debe incluir",
  "Cada producto del remito debe aparecer una sola vez",
  "Cada precio debe ser mayor a cero",
  "Cada descuento debe estar entre 0 y 100",
  "El remito contiene una cantidad inválida",
  "No cambió ningún precio ni descuento",
  "El total corregido debe ser mayor a cero",
  "La deuda del remito no está íntegra",
  "La deuda del remito no pudo actualizarse",
] as const;

function netoDesdePrecioFinal(precioFinal: number, ivaPorcentaje: number): number {
  return round2(precioFinal / (1 + ivaPorcentaje / 100));
}

function mensajeError(error: unknown): string {
  const mensaje =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : "";
  const permitido = MENSAJES_RPC_PERMITIDOS.find((texto) => mensaje.includes(texto));
  return permitido
    ? mensaje.slice(mensaje.indexOf(permitido)).split("\n")[0]
    : "No se pudo guardar la corrección. Revisá los datos e intentá nuevamente.";
}

function prepararItems(items: ItemVenta[]): ItemEditable[] {
  return items.map((item) => ({
    id: item.id,
    codigo: item.codigo,
    descripcion: item.descripcion,
    cantidad: Number(item.cantidad),
    ivaPorcentaje: Number(item.iva_porcentaje),
    precioFinal: conIva(item.precio_unitario_sin_iva, item.iva_porcentaje),
    descuentoPorcentaje: Number(item.descuento_porcentaje),
    precioNetoOriginal: Number(item.precio_unitario_sin_iva),
    descuentoOriginal: Number(item.descuento_porcentaje),
  }));
}

export function DialogoCorregirPreciosRemito({
  ventaId,
  numeroRemito,
  versionEsperada,
  items,
  onClose,
  onSaved,
}: {
  ventaId: string;
  numeroRemito: string;
  versionEsperada: number;
  items: ItemVenta[];
  onClose(): void;
  onSaved(): Promise<void> | void;
}) {
  const [editables, setEditables] = useState(() => prepararItems(items));
  const [motivo, setMotivo] = useState("");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: async () => {
      const motivoLimpio = motivo.trim();
      if (motivoLimpio.length < 5) {
        throw new Error("Escribí un motivo concreto de al menos 5 caracteres.");
      }
      if (motivoLimpio.length > 1000) {
        throw new Error("El motivo no puede superar los 1000 caracteres.");
      }

      const payload = editables.map((item) => {
        if (
          item.precioFinal === null ||
          !Number.isFinite(item.precioFinal) ||
          item.precioFinal <= 0
        ) {
          throw new Error("Cada precio debe ser mayor a cero.");
        }
        if (
          item.descuentoPorcentaje === null ||
          !Number.isFinite(item.descuentoPorcentaje) ||
          item.descuentoPorcentaje < 0 ||
          item.descuentoPorcentaje > 100
        ) {
          throw new Error("Cada descuento debe estar entre 0 y 100.");
        }
        return {
          item_id: item.id,
          precio_unitario_sin_iva: netoDesdePrecioFinal(item.precioFinal, item.ivaPorcentaje),
          descuento_porcentaje: round2(item.descuentoPorcentaje),
        };
      });

      const cambio = payload.some(
        (item, indice) =>
          item.precio_unitario_sin_iva !== editables[indice].precioNetoOriginal ||
          item.descuento_porcentaje !== editables[indice].descuentoOriginal,
      );
      if (!cambio) throw new Error("No cambió ningún precio ni descuento.");

      const { error } = await supabase.rpc("corregir_precios_remito", {
        p_venta_id: ventaId,
        p_items: payload,
        p_motivo: motivoLimpio,
        p_version_esperada: versionEsperada,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success("Precios del remito corregidos y auditados");
      await onSaved();
    },
    onError: (error) => setErrorLocal(mensajeError(error)),
  });

  const actualizarItem = (
    id: string,
    campo: "precioFinal" | "descuentoPorcentaje",
    valor: number | null,
  ) => {
    setErrorLocal(null);
    guardar.reset();
    setEditables((actuales) =>
      actuales.map((item) => (item.id === id ? { ...item, [campo]: valor } : item)),
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !guardar.isPending && onClose()}>
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] max-w-3xl"
        closeDisabled={guardar.isPending}
      >
        <DialogHeader>
          <DialogTitle>Corregir precios del remito</DialogTitle>
          <DialogDescription>
            {numeroRemito}. Podés cambiar el precio final y el descuento. Productos, cantidades y
            stock permanecen sin cambios.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 overflow-y-auto pr-1"
          onSubmit={(event) => {
            event.preventDefault();
            setErrorLocal(null);
            guardar.mutate();
          }}
        >
          <div className="space-y-3">
            {editables.map((item) => (
              <div key={item.id} className="rounded-lg border border-border p-3">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="font-medium">{item.descripcion}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.codigo} · Cantidad {item.cantidad}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground">IVA incluido</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`precio-final-${item.id}`}>Precio final</Label>
                    <NumberInput
                      id={`precio-final-${item.id}`}
                      aria-label={`Precio final de ${item.codigo}`}
                      className="mt-1 text-right font-mono tabular-nums"
                      value={item.precioFinal}
                      min={0.01}
                      disabled={guardar.isPending}
                      onValueChange={(valor) => actualizarItem(item.id, "precioFinal", valor)}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`descuento-${item.id}`}>Descuento %</Label>
                    <NumberInput
                      id={`descuento-${item.id}`}
                      aria-label={`Descuento de ${item.codigo}`}
                      className="mt-1 text-right font-mono tabular-nums"
                      value={item.descuentoPorcentaje}
                      min={0}
                      max={100}
                      disabled={guardar.isPending}
                      onValueChange={(valor) =>
                        actualizarItem(item.id, "descuentoPorcentaje", valor)
                      }
                    />
                  </div>
                </div>
                {item.precioFinal !== null && item.descuentoPorcentaje !== null ? (
                  <p className="mt-2 text-right text-xs text-muted-foreground">
                    Subtotal estimado:{" "}
                    {fmtMoney(
                      round2(
                        item.precioFinal * item.cantidad * (1 - item.descuentoPorcentaje / 100),
                      ),
                    )}
                  </p>
                ) : null}
              </div>
            ))}
          </div>

          <div>
            <Label htmlFor="correccion-precios-motivo">Motivo de la corrección</Label>
            <Textarea
              id="correccion-precios-motivo"
              className="mt-1"
              rows={3}
              required
              minLength={5}
              maxLength={1000}
              value={motivo}
              disabled={guardar.isPending}
              aria-describedby="ayuda-correccion-precios"
              placeholder="Ej: se acordó un precio nuevo con el cliente"
              onChange={(event) => {
                setErrorLocal(null);
                guardar.reset();
                setMotivo(event.target.value);
              }}
            />
            <p id="ayuda-correccion-precios" className="mt-1 text-xs text-muted-foreground">
              La corrección actualiza la deuda de cuenta corriente y guarda quién la hizo, cuándo,
              el motivo y los valores anteriores.
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
            <Button type="submit" disabled={guardar.isPending}>
              {guardar.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {guardar.isPending ? "Guardando…" : "Guardar corrección"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
