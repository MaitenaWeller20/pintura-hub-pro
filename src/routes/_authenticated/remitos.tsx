import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Check, X, Printer, ArrowRight, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { crearRemito, aprobarRemito, rechazarRemito } from "@/lib/stock.functions";
import { fmtDateTime } from "@/lib/format";
import { filtroProducto, TOPE_BUSQUEDA_PRODUCTOS } from "@/lib/postgrest";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export const Route = createFileRoute("/_authenticated/remitos")({
  component: RemitosPage,
});

function RemitosPage() {
  const { data: cu } = useCurrentUser();
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [rechazar, setRechazar] = useState<any>(null);
  const aprobarFn = useServerFn(aprobarRemito);
  const rechazarFn = useServerFn(rechazarRemito);

  const { data: remitos = [] } = useQuery({
    queryKey: ["remitos"],
    queryFn: async () =>
      ((
        await supabase
          .from("remitos")
          .select(
            `
      *, origen:sucursales!sucursal_origen_id(nombre), destino:sucursales!sucursal_destino_id(nombre),
      items:remito_items(cantidad, producto:productos(codigo,nombre))
    `,
          )
          .order("created_at", { ascending: false })
      ).data ?? []) as any[],
  });

  const aprobar = useMutation({
    mutationFn: async (id: string) => aprobarFn({ data: { remito_id: id } }),
    onSuccess: () => {
      toast.success("Remito aprobado y stock transferido");
      qc.invalidateQueries({ queryKey: ["remitos"] });
    },
    onError: (e: any) => toast.error(e.message),
  });
  const rech = useMutation({
    mutationFn: async (d: any) => rechazarFn({ data: d }),
    onSuccess: () => {
      toast.success("Remito rechazado");
      qc.invalidateQueries({ queryKey: ["remitos"] });
      setRechazar(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const imprimir = (r: any) => {
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text(`CasaForma — Remito interno ${r.numero}`, 14, 16);
    doc.setFontSize(10);
    doc.text(`Origen: ${r.origen?.nombre}   Destino: ${r.destino?.nombre}`, 14, 24);
    doc.text(`Estado: ${r.estado}   Fecha: ${fmtDateTime(r.created_at)}`, 14, 30);
    autoTable(doc, {
      startY: 36,
      head: [["Código", "Producto", "Cantidad"]],
      body: (r.items ?? []).map((i: any) => [i.producto?.codigo, i.producto?.nombre, i.cantidad]),
      styles: { fontSize: 9 },
    });
    if (r.observaciones) {
      const y = (doc as any).lastAutoTable.finalY + 8;
      doc.text(`Obs: ${r.observaciones}`, 14, y);
    }
    doc.save(`${r.numero}.pdf`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Remitos internos</h1>
          <p className="text-sm text-muted-foreground">Transferencias entre sucursales</p>
        </div>
        <Button onClick={() => setShowNew(true)}>
          <Plus className="h-4 w-4 mr-1" /> Nuevo remito
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Número</TableHead>
              <TableHead>Origen → Destino</TableHead>
              <TableHead>Productos</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {remitos.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.numero}</TableCell>
                <TableCell className="text-sm">
                  {r.origen?.nombre} <ArrowRight className="h-3 w-3 inline mx-1" />{" "}
                  {r.destino?.nombre}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.items?.length ?? 0} ítems
                </TableCell>
                <TableCell className="text-xs">{fmtDateTime(r.created_at)}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      r.estado === "APROBADO"
                        ? "bg-success text-success-foreground"
                        : r.estado === "RECHAZADO"
                          ? "bg-destructive text-destructive-foreground"
                          : "bg-warning text-warning-foreground"
                    }
                  >
                    {r.estado}
                  </Badge>
                </TableCell>
                <TableCell className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => imprimir(r)}>
                    <Printer className="h-3.5 w-3.5" />
                  </Button>
                  {/* R7: aprueba/rechaza sólo la sucursal DESTINO (o un admin). */}
                  {(cu?.isAdmin || cu?.sucursal?.id === r.sucursal_destino_id) &&
                    r.estado === "PENDIENTE" && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={aprobar.isPending || rech.isPending}
                          onClick={() => aprobar.mutate(r.id)}
                        >
                          <Check className="h-3.5 w-3.5 text-success" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={aprobar.isPending || rech.isPending}
                          onClick={() => setRechazar(r)}
                        >
                          <X className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </>
                    )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Montado sólo cuando se abre: así el formulario arranca limpio en cada
          apertura y no queda con lo tipeado la vez anterior. La precarga del
          origen la resuelve un efecto adentro del diálogo (ver ahí el porqué). */}
      {showNew && (
        <NuevoRemitoDialog
          open
          onClose={() => setShowNew(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["remitos"] });
            setShowNew(false);
          }}
        />
      )}

      <Dialog open={!!rechazar} onOpenChange={(v) => !v && setRechazar(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rechazar remito {rechazar?.numero}</DialogTitle>
          </DialogHeader>
          <Label>Motivo *</Label>
          <Textarea id="motivo_rechazo" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRechazar(null)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const mot = (document.getElementById("motivo_rechazo") as HTMLTextAreaElement)
                  .value;
                if (!mot.trim()) return toast.error("Motivo requerido");
                rech.mutate({ remito_id: rechazar.id, motivo: mot });
              }}
            >
              Rechazar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NuevoRemitoDialog({ open, onClose, onSaved }: any) {
  const { data: cu } = useCurrentUser();
  const crear = useServerFn(crearRemito);
  const [origen, setOrigen] = useState<string>(cu?.sucursal?.id ?? "");

  // `useCurrentUser` resuelve el perfil en un efecto propio, así que en el
  // primer render SIEMPRE es null y el useState de arriba se inicializaba en
  // "" para todo el mundo — nunca precargaba nada. Como el botón se
  // deshabilitaba con `!origen`, quedaba gris sin explicación: eso era "no me
  // deja hacer remitos". Se sincroniza cuando llega el perfil, sin pisar lo que
  // el usuario ya haya elegido a mano.
  useEffect(() => {
    const mia = cu?.sucursal?.id;
    if (mia) setOrigen((actual) => actual || mia);
  }, [cu?.sucursal?.id]);
  const [destino, setDestino] = useState<string>("");
  const [obs, setObs] = useState("");
  const [items, setItems] = useState<
    Array<{ producto_id: string; codigo: string; nombre: string; cantidad: number }>
  >([]);
  const [pq, setPq] = useState("");

  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*")).data ?? []) as any[],
  });
  const { data: prods = [] } = useQuery({
    queryKey: ["prods-rem", pq],
    enabled: pq.length >= 2,
    // Mismo arreglo que en presupuestos: 10 sin `order` dejaba productos afuera
    // en silencio. No se filtra por `activo` a propósito: un producto dado de
    // baja puede tener stock que igual haya que mover entre sucursales.
    queryFn: async () => {
      const filtro = filtroProducto(pq);
      if (!filtro) return [] as any[];
      return ((
        await supabase
          .from("productos")
          .select("id,codigo,nombre")
          .eq("archivado", false)
          .or(filtro)
          .order("codigo")
          .limit(TOPE_BUSQUEDA_PRODUCTOS)
      ).data ?? []) as any[];
    },
  });

  const m = useMutation({
    mutationFn: async () =>
      crear({
        data: {
          sucursal_origen_id: origen,
          sucursal_destino_id: destino,
          observaciones: obs,
          items: items.map((i) => ({ producto_id: i.producto_id, cantidad: Number(i.cantidad) })),
        },
      }),
    onSuccess: (r: any) => {
      toast.success(`Remito ${r.numero} creado (pendiente de aprobación)`);
      onSaved();
    },
    onError: (e: any) => toast.error(e.message),
  });

  // El remito lo crea la sucursal que SACA la mercadería: el servidor rechaza
  // un origen que no sea la propia (salvo admin). Se avisa acá para que el
  // motivo se lea antes de apretar, y no como error después.
  const origenAjeno = !cu?.isAdmin && !!cu?.sucursal?.id && !!origen && origen !== cu.sucursal.id;
  const noPuede = !origen
    ? "Elegí la sucursal de origen."
    : origenAjeno
      ? "Sólo podés crear remitos que salgan de tu sucursal."
      : !destino
        ? "Elegí la sucursal de destino."
        : origen === destino
          ? "El origen y el destino tienen que ser distintos."
          : items.length === 0
            ? "Agregá al menos un producto."
            : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nuevo remito de transferencia</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Origen *</Label>
            <Select value={origen} onValueChange={setOrigen}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {sucs.map((s: any) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Destino *</Label>
            <Select value={destino} onValueChange={setDestino}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {sucs
                  .filter((s: any) => s.id !== origen)
                  .map((s: any) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.nombre}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label>Productos *</Label>

          {/* El buscador va ADENTRO del diálogo, no en un popover.
              Estaba anclado al botón "Agregar", que es chico y está pegado al
              borde: el panel abría hacia afuera, se salía del diálogo por la
              derecha y por abajo, y tapaba la tabla que venía a llenar.
              Es el mismo patrón que ya usa Presupuestos, que entra siempre. */}
          <div className="relative mt-1">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por código o nombre…"
              value={pq}
              onChange={(e) => setPq(e.target.value)}
              data-testid="remito-buscar-producto"
            />
          </div>

          {pq.trim().length >= 2 && prods.length > 0 && (
            <div className="mt-1 max-h-48 overflow-auto rounded-lg border border-border">
              {prods.map((p: any) => {
                const yaEsta = items.some((i) => i.producto_id === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={yaEsta}
                    className="flex w-full gap-3 p-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
                    onClick={() => {
                      setItems((i) => [
                        ...i,
                        { producto_id: p.id, codigo: p.codigo, nombre: p.nombre, cantidad: 1 },
                      ]);
                      setPq("");
                    }}
                  >
                    <span className="w-28 shrink-0 font-mono text-xs">{p.codigo}</span>
                    <span className="truncate">{p.nombre}</span>
                    {yaEsta && <span className="ml-auto shrink-0 text-xs">ya está</span>}
                  </button>
                );
              })}
            </div>
          )}
          {/* Que la lista esté cortada tiene que verse: si no, parece que el
              producto no existe. */}
          {prods.length >= TOPE_BUSQUEDA_PRODUCTOS && (
            <p className="mt-1 text-xs text-muted-foreground">
              Se muestran los primeros {TOPE_BUSQUEDA_PRODUCTOS}. Escribí un poco más para afinar.
            </p>
          )}
          {pq.trim().length >= 2 && prods.length === 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Ningún producto con ese código o nombre.
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Producto</TableHead>
                <TableHead>Cant.</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{it.codigo}</TableCell>
                  <TableCell>{it.nombre}</TableCell>
                  <TableCell>
                    <NumberInput
                      className="h-8 w-20"
                      value={it.cantidad}
                      onValueChange={(v) =>
                        setItems((is) =>
                          is.map((x, idx) => (idx === i ? { ...x, cantidad: v ?? 0 } : x)),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setItems((is) => is.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div>
          <Label>Observaciones</Label>
          <Textarea value={obs} onChange={(e) => setObs(e.target.value)} rows={2} />
        </div>
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {/* Un botón gris sin explicación deja al usuario adivinando: eso fue
              exactamente lo que pasó con los remitos entre sucursales. */}
          {noPuede && <span className="text-xs text-muted-foreground sm:mr-auto">{noPuede}</span>}
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} disabled={!!noPuede || m.isPending}>
            {m.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Crear remito
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
