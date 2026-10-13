import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  calcularCambiosCorreccionIngreso,
  prepararSolicitudCorreccionIngreso,
  type LineaCorreccionIngreso,
} from "@/lib/correccion-ingreso";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Esta RPC nace en la misma migración que la pantalla. El cast mantiene el
// deploy desacoplado de la regeneración masiva del archivo automático types.ts.
const supabaseCorrecciones = supabase as unknown as SupabaseClient;

export type ItemIngresoCorregible = {
  id: string;
  producto_id: string | null;
  origen_match: string;
  codigo: string | null;
  descripcion: string | null;
  cantidad: number | null;
};

type IngresoCorregible = {
  id: string;
};

function fmtCantidad(value: number) {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(value);
}

export function DialogoCorregirIngreso({
  ingreso,
  items,
  onClose,
  onSuccess,
}: {
  ingreso: IngresoCorregible;
  items: ItemIngresoCorregible[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const [motivo, setMotivo] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [cantidades, setCantidades] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.id, String(Number(item.cantidad ?? 0))])),
  );

  const lineas: LineaCorreccionIngreso[] = items.map((item) => ({
    itemId: item.id,
    descripcion: item.descripcion ?? item.codigo ?? "Producto",
    cantidadAnterior: Number(item.cantidad ?? 0),
    cantidadNueva: cantidades[item.id] === "" ? Number.NaN : Number(cantidades[item.id]),
  }));

  let cambios: ReturnType<typeof calcularCambiosCorreccionIngreso> = [];
  let errorCantidad: string | null = null;
  try {
    cambios = calcularCambiosCorreccionIngreso(lineas);
  } catch (error) {
    errorCantidad = error instanceof Error ? error.message : "Revisá las cantidades.";
  }
  const deltaTotal = cambios.reduce((total, cambio) => total + cambio.delta, 0);

  const corregir = useMutation({
    mutationFn: async () => {
      const solicitud = prepararSolicitudCorreccionIngreso({
        ingresoId: ingreso.id,
        idempotencyKey,
        motivo,
        items: lineas,
      });
      const { data, error } = await supabaseCorrecciones.rpc(
        "corregir_ingreso_mercaderia",
        solicitud,
      );
      if (error) throw error;
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ingresos-mercaderia"] }),
        queryClient.invalidateQueries({ queryKey: ["ingreso-items", ingreso.id] }),
        queryClient.invalidateQueries({ queryKey: ["ingreso-correcciones", ingreso.id] }),
        queryClient.invalidateQueries({ queryKey: ["inventario"] }),
        queryClient.invalidateQueries({ queryKey: ["productos"] }),
        queryClient.invalidateQueries({ queryKey: ["stock-hoy"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      toast.success("Cantidades corregidas y stock actualizado");
      onSuccess();
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "No se pudo aplicar la corrección"),
  });

  const submit = () => {
    try {
      prepararSolicitudCorreccionIngreso({
        ingresoId: ingreso.id,
        idempotencyKey,
        motivo,
        items: lineas,
      });
      corregir.mutate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Revisá la corrección");
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !corregir.isPending && onClose()}>
      <DialogContent
        className="max-w-3xl"
        onInteractOutside={(event) => corregir.isPending && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Corregir cantidades del ingreso</DialogTitle>
          <DialogDescription>
            Ajustá sólo las líneas incorrectas e indicá el motivo. El stock se actualizará por la
            diferencia.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            La diferencia se aplicará ahora al stock y quedará registrada con tu usuario. No se
            puede reducir una cantidad si esa mercadería ya salió del inventario.
          </p>
        </div>

        <div className="max-h-[45vh] overflow-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead className="w-28 text-right">Registrada</TableHead>
                <TableHead className="w-40">Nueva cantidad</TableHead>
                <TableHead className="w-24 text-right">Diferencia</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const cambio = cambios.find((candidate) => candidate.itemId === item.id);
                const inputId = `cantidad-corregida-${item.id}`;
                return (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.codigo ?? "—"}</TableCell>
                    <TableCell>{item.descripcion ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmtCantidad(Number(item.cantidad ?? 0))}
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={inputId} className="sr-only">
                        Nueva cantidad de {item.descripcion ?? item.codigo ?? "producto"}
                      </Label>
                      <Input
                        id={inputId}
                        aria-label={`Nueva cantidad de ${item.descripcion ?? item.codigo ?? "producto"}`}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={cantidades[item.id] ?? ""}
                        disabled={corregir.isPending}
                        onChange={(event) =>
                          setCantidades((current) => ({
                            ...current,
                            [item.id]: event.target.value,
                          }))
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {cambio ? `${cambio.delta > 0 ? "+" : ""}${fmtCantidad(cambio.delta)}` : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-2">
          <Label htmlFor="motivo-correccion-ingreso">Motivo</Label>
          <Textarea
            id="motivo-correccion-ingreso"
            value={motivo}
            maxLength={500}
            disabled={corregir.isPending}
            placeholder="Ej.: el remito traía 2 unidades, no 4"
            onChange={(event) => setMotivo(event.target.value)}
          />
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span className={errorCantidad ? "text-destructive" : ""}>
              {errorCantidad ??
                `${cambios.length} ${cambios.length === 1 ? "línea modificada" : "líneas modificadas"}`}
            </span>
            <span>
              Variación total: {deltaTotal > 0 ? "+" : ""}
              {fmtCantidad(deltaTotal)} unidades
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={corregir.isPending}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={
              corregir.isPending || !!errorCantidad || cambios.length === 0 || !motivo.trim()
            }
          >
            {corregir.isPending ? "Aplicando…" : "Aplicar corrección"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
