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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  FORMAS_PAGO_CORREGIBLES,
  mensajeErrorCorreccionFormaPago,
  validarCorreccionFormaPago,
  type FormaPagoCorregible,
} from "@/lib/correccion-forma-pago";
import { fmtMoney, formaPagoLabel } from "@/lib/format";

export type PagoFormaCorregible = Pick<
  Database["public"]["Tables"]["venta_pagos"]["Row"],
  "id" | "forma_pago" | "monto" | "correccion_version"
>;

function esFormaCorregible(forma: string): forma is FormaPagoCorregible {
  return FORMAS_PAGO_CORREGIBLES.some((opcion) => opcion === forma);
}

export function DialogoCorregirFormaPago({
  pago,
  numeroVenta,
  onClose,
  onSaved,
}: {
  pago: PagoFormaCorregible;
  numeroVenta: string;
  onClose(): void;
  onSaved(): Promise<void> | void;
}) {
  const formaActual = pago.forma_pago;
  const [formaNueva, setFormaNueva] = useState<FormaPagoCorregible>(
    esFormaCorregible(formaActual) ? formaActual : FORMAS_PAGO_CORREGIBLES[0],
  );
  const [motivo, setMotivo] = useState("");
  const [errorLocal, setErrorLocal] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: async () => {
      const validacion = validarCorreccionFormaPago({ formaActual, formaNueva, motivo });
      if (validacion) throw new Error(validacion);

      const { error } = await supabase.rpc("corregir_forma_pago_venta", {
        p_venta_pago_id: pago.id,
        p_forma_pago_nueva: formaNueva,
        p_motivo: motivo.trim(),
        p_version_esperada: pago.correccion_version,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      toast.success("Forma de pago corregida y auditada");
      await onSaved();
    },
    onError: (error) => setErrorLocal(mensajeErrorCorreccionFormaPago(error)),
  });

  const limpiarError = () => {
    setErrorLocal(null);
    guardar.reset();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !guardar.isPending && onClose()}>
      <DialogContent className="max-w-lg" closeDisabled={guardar.isPending}>
        <DialogHeader>
          <DialogTitle>Corregir forma de pago</DialogTitle>
          <DialogDescription>
            Venta {numeroVenta}. Sólo cambia el medio; el importe permanece exactamente igual.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setErrorLocal(null);
            guardar.mutate();
          }}
        >
          <div>
            <Label htmlFor="correccion-pago-importe">Importe (no editable)</Label>
            <Input
              id="correccion-pago-importe"
              className="mt-1 font-mono tabular-nums"
              value={fmtMoney(pago.monto)}
              readOnly
              aria-readonly="true"
            />
          </div>

          <div>
            <Label htmlFor="correccion-pago-forma">Forma de pago</Label>
            <Select
              value={formaNueva}
              disabled={guardar.isPending}
              onValueChange={(value) => {
                limpiarError();
                setFormaNueva(value as FormaPagoCorregible);
              }}
            >
              <SelectTrigger id="correccion-pago-forma" className="mt-1 min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMAS_PAGO_CORREGIBLES.map((forma) => (
                  <SelectItem key={forma} value={forma}>
                    {formaPagoLabel[forma]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="correccion-pago-motivo">Motivo de la corrección</Label>
            <Textarea
              id="correccion-pago-motivo"
              className="mt-1"
              rows={3}
              required
              minLength={5}
              maxLength={1000}
              value={motivo}
              disabled={guardar.isPending}
              aria-describedby="ayuda-correccion-pago"
              placeholder="Ej: se informó efectivo en vez de transferencia"
              onChange={(event) => {
                limpiarError();
                setMotivo(event.target.value);
              }}
            />
            <p id="ayuda-correccion-pago" className="mt-1 text-xs text-muted-foreground">
              Se guardan tu identidad, el motivo y ambas formas de pago. Los datos propios del medio
              anterior se limpian para evitar referencias incorrectas.
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
