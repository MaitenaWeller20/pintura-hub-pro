import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { PageHeader } from "@/components/app/page-header";
import { DataTable } from "@/components/app/data-table";
import { SectionCard } from "@/components/app/section-card";
import { StatusPill } from "@/components/app/status-pill";
import { toast } from "sonner";
import { Plus, Pencil, Receipt, Upload, Loader2, Download } from "lucide-react";
import * as XLSX from "xlsx";
import { traerTodo } from "@/lib/supabase-paginado";
import {
  detectarColumnasCliente,
  procesarClientes,
  type ClienteNuevo,
  type ColumnasCliente,
} from "@/lib/importar-clientes";
import { tipoClienteLabel } from "@/lib/format";
import { coincideDocumento, fmtDocumento, soloDigitos } from "@/lib/documento";
import { errorDocumentoLegible } from "@/lib/duplicado-documento";
import { validarCuitDni } from "@/lib/fiscal/codigos";
import { useCurrentUser } from "@/hooks/use-current-user";

export const Route = createFileRoute("/_authenticated/clientes")({
  component: ClientesPage,
});

function ClientesPage() {
  const qc = useQueryClient();
  const { data: cu } = useCurrentUser();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [importarAbierto, setImportarAbierto] = useState(false);

  const { data: inventarioClientes, isLoading } = useQuery({
    queryKey: ["clientes"],
    // Paginado explícito: PostgREST corta en 1000 filas y NO avisa. Con los
    // ~1400 clientes que vienen de la migración, un `select` pelado devolvía
    // 1000 y el resto desaparecía — y la importación, que usa esta lista para
    // no duplicar, habría vuelto a crear a los que quedaban afuera.
    queryFn: async () =>
      (
        await traerTodo<any>(async (desde, hasta) => {
          const { data, error, count } = await supabase
            .from("clientes")
            .select("*, sucursal:sucursales(nombre)", { count: "exact" })
            .order("razon_social")
            .order("id")
            .range(desde, hasta);
          return { data, error, count };
        })
      ),
  });
  const clientes = inventarioClientes?.filas ?? [];
  const clientesTruncados = inventarioClientes?.truncado ?? false;
  const { data: sucs = [] } = useQuery({
    queryKey: ["sucs"],
    queryFn: async () => ((await supabase.from("sucursales").select("*").order("numero")).data ?? []) as any[],
  });

  // El documento se compara por sus dígitos, así que da igual si la usuaria
  // escribe "30715826077" o "30-71582607-7".
  const filtered = useMemo(() => clientes.filter((c:any) => coincideDocumento(c, q)), [clientes, q]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clientes"
        subtitle={`${filtered.length} de ${clientes.length}`}
        actions={
          <>
            {/* Sólo admin: el trigger `guard_clientes_credito` impide que un
                empleado cree clientes con cuenta corriente, así que a mitad del
                lote la importación se cortaría con un error de permisos. */}
            {cu?.isAdmin && (
              <Button variant="outline" onClick={()=>setImportarAbierto(true)}>
                <Upload className="h-4 w-4 mr-1"/> Importar
              </Button>
            )}
            <Button onClick={()=>{ setEditing(null); setOpen(true); }}><Plus className="h-4 w-4 mr-1"/> Nuevo</Button>
          </>
        }
      />

      <SectionCard>
        <Input placeholder="Buscar por nombre o CUIT…" value={q} onChange={(e)=>setQ(e.target.value)} className="max-w-sm"/>
      </SectionCard>

      <DataTable
        columns={["Razón social", "CUIT/DNI", "Tipo", "Cta Cte", "Teléfono", "Sucursal", ""]}
        loading={isLoading}
        isEmpty={filtered.length === 0}
        empty={{ text: "No hay clientes para mostrar." }}
      >
        {filtered.map((c:any) => (
          <TableRow key={c.id}>
            <TableCell>
              {c.razon_social}
              {c.es_generico && <span className="ml-2 align-middle"><StatusPill tone="neutral">Genérico</StatusPill></span>}
            </TableCell>
            <TableCell className="font-mono text-xs">{fmtDocumento(c.cuit_dni)}</TableCell>
            <TableCell className="text-muted-foreground text-xs">{tipoClienteLabel[c.tipo]}</TableCell>
            <TableCell>{c.condicion_cta_cte ? <StatusPill tone="success">Sí</StatusPill> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
            <TableCell>{c.telefono ?? "—"}</TableCell>
            <TableCell className="text-muted-foreground">{c.sucursal?.nombre ?? "—"}</TableCell>
            <TableCell>
              <div className="flex gap-1 justify-end">
                {c.condicion_cta_cte && (
                  <Button size="sm" variant="ghost" asChild title="Ver cuenta corriente">
                    <Link to="/cuentas-corrientes" search={{ cliente: c.id }}><Receipt className="h-3.5 w-3.5"/></Link>
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={()=>{ setEditing(c); setOpen(true); }}><Pencil className="h-3.5 w-3.5"/></Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>

      {/* key: fuerza remontar el diálogo al abrirlo o al cambiar de cliente, para que
          el form se inicialice con los datos del cliente. Sin esto, useState(editing…)
          se evaluaba una sola vez (con editing=null) y editar guardaba campos vacíos. */}
      {importarAbierto && (
        <ImportarClientesDialog
          existentes={clientes}
          listaTruncada={clientesTruncados}
          onClose={()=>setImportarAbierto(false)}
          onImportado={()=>{ setImportarAbierto(false); qc.invalidateQueries({ queryKey:["clientes"] }); }}
        />
      )}

      <ClienteDialog key={`${editing?.id ?? "nuevo"}-${open}`} open={open} onClose={()=>setOpen(false)} editing={editing} sucs={sucs}
        onSaved={()=>{ qc.invalidateQueries({ queryKey:["clientes"] }); setOpen(false); }}/>
    </div>
  );
}

function ClienteDialog({ open, onClose, editing, sucs, onSaved }: any) {
  const [form, setForm] = useState<any>(editing ?? {
    razon_social: "", cuit_dni: "", tipo: "CONSUMIDOR_FINAL",
    telefono: "", email: "", direccion: "", sucursal_habitual_id: null,
    condicion_cta_cte: false,
  });
  const set = (k:string,v:any) => setForm((f:any)=>({ ...f, [k]: v }));
  const cuitError = validarCuitDni(form.cuit_dni);
  const m = useMutation({
    mutationFn: async () => {
      const errCuit = validarCuitDni(form.cuit_dni);
      if (errCuit) throw new Error(errCuit);
      // Se guarda normalizado (sólo dígitos); vacío -> null para que el índice
      // único parcial lo ignore (consumidor final sin identificar). El trigger
      // `normalizar_cuit_dni` lo garantiza igual del lado de la base.
      const cuitNorm = soloDigitos(form.cuit_dni);
      const payload = { ...form, cuit_dni: cuitNorm || null, sucursal_habitual_id: form.sucursal_habitual_id || null };
      delete payload.sucursal; delete payload.created_at; delete payload.updated_at; delete payload.es_generico; delete payload.activo;
      const { error } = editing
        ? await supabase.from("clientes").update(payload).eq("id", editing.id)
        : await supabase.from("clientes").insert(payload);
      // El mensaje dice de quién es el CUIT: sin el nombre, un duplicado deja
      // trabado a quien lo carga.
      if (error) throw new Error(await errorDocumentoLegible("clientes", error, cuitNorm));
    },
    onSuccess: () => { toast.success("Cliente guardado"); onSaved(); },
    onError: (e:any) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{editing ? "Editar" : "Nuevo"} cliente</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Razón social / Nombre *</Label><Input value={form.razon_social} onChange={(e)=>set("razon_social", e.target.value)}/></div>
          <div>
            <Label>CUIT / DNI</Label>
            <Input value={form.cuit_dni ?? ""} onChange={(e)=>set("cuit_dni", e.target.value)}
              className={cuitError ? "border-destructive" : undefined}/>
            {cuitError && <p className="text-xs text-destructive mt-1">{cuitError}</p>}
          </div>
          <div>
            <Label>Tipo impositivo</Label>
            <Select value={form.tipo} onValueChange={(v)=>set("tipo", v)}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="CONSUMIDOR_FINAL">Consumidor Final</SelectItem>
                <SelectItem value="RESPONSABLE_INSCRIPTO">Responsable Inscripto</SelectItem>
                <SelectItem value="MONOTRIBUTISTA">Monotributista</SelectItem>
                <SelectItem value="EXENTO">Exento</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div><Label>Teléfono</Label><Input value={form.telefono ?? ""} onChange={(e)=>set("telefono", e.target.value)}/></div>
          <div><Label>Email</Label><Input value={form.email ?? ""} onChange={(e)=>set("email", e.target.value)}/></div>
          <div className="col-span-2"><Label>Dirección</Label><Input value={form.direccion ?? ""} onChange={(e)=>set("direccion", e.target.value)}/></div>
          <div className="col-span-2">
            <Label>Sucursal habitual</Label>
            <Select value={form.sucursal_habitual_id ?? "__none__"} onValueChange={(v)=>set("sucursal_habitual_id", v==="__none__"?null:v)}>
              <SelectTrigger><SelectValue/></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">—</SelectItem>
                {sucs.map((s:any)=>(<SelectItem key={s.id} value={s.id}>{s.nombre}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <label className="col-span-2 flex items-center gap-2 text-sm border border-border rounded p-2 bg-muted/30">
            <input type="checkbox" checked={!!form.condicion_cta_cte} onChange={(e)=>set("condicion_cta_cte", e.target.checked)} />
            <span><strong>Cliente con Cuenta Corriente</strong> — puede llevar mercadería sin pagar en el momento. Gestionar deuda en la pestaña Cta Cte.</span>
          </label>
          {form.condicion_cta_cte && (
            <div className="col-span-2">
              <Label>Límite de crédito (opcional)</Label>
              <NumberInput value={form.limite_credito ?? null} onValueChange={(v)=>set("limite_credito", v)} className="max-w-xs" />
              <p className="text-[11px] text-muted-foreground mt-1">Deuda máxima que se le permite acumular. Vacío = sin límite.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={()=>m.mutate()} disabled={m.isPending || !form.razon_social.trim() || !!cuitError}>Guardar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Importar una lista de clientes.
 *
 * Igual que la importación de conteo: primero un resumen de qué va a pasar y qué
 * queda afuera, y recién después se escribe. Acá el riesgo no es borrar sino
 * DUPLICAR — un cliente repetido parte su cuenta corriente y su historial de
 * ventas en dos fichas, y juntarlas después es a mano.
 * Ver docs/superpowers/specs/2026-08-04-importar-clientes-design.md
 */
function ImportarClientesDialog({
  existentes,
  listaTruncada,
  onClose,
  onImportado,
}: {
  existentes: any[];
  /** La lista de clientes vino incompleta: no se puede chequear duplicados. */
  listaTruncada: boolean;
  onClose: () => void;
  onImportado: () => void;
}) {
  const qcDialog = useQueryClient();
  const [encabezados, setEncabezados] = useState<string[]>([]);
  const [filas, setFilas] = useState<Array<Record<string, unknown>>>([]);
  const [cols, setCols] = useState<ColumnasCliente>({
    razon_social: null, cuit: null, cta_cte: null, domicilio: null, telefono: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [progreso, setProgreso] = useState<{ hechos: number; total: number } | null>(null);

  const listaExistentes = useMemo(
    () => existentes.map((c:any) => ({ razon_social: c.razon_social, cuit_dni: c.cuit_dni })),
    [existentes],
  );

  const res = useMemo(
    () => (filas.length ? procesarClientes(filas, cols, listaExistentes) : null),
    [filas, cols, listaExistentes],
  );

  const leerArchivo = async (file: File) => {
    // Se limpia TODO antes de leer. Si no, mientras carga el archivo nuevo
    // quedan a la vista el resumen y el botón del anterior, y alcanza para
    // importar el archivo equivocado.
    setLeyendo(true); setError(null); setFilas([]); setEncabezados([]); setProgreso(null);
    setCols({ razon_social: null, cuit: null, cta_cte: null, domicilio: null, telefono: null });
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      if (wb.SheetNames.length === 0) throw new Error("El archivo no tiene ninguna hoja.");
      const f = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      if (f.length === 0) throw new Error("La primera hoja está vacía.");
      const heads = Object.keys(f[0]);
      setEncabezados(heads); setFilas(f); setCols(detectarColumnasCliente(heads));
    } catch (e: any) {
      setError(e.message ?? "No se pudo leer el archivo.");
      setFilas([]); setEncabezados([]);
    } finally { setLeyendo(false); }
  };

  const bajar = (nombre: string, filas: Array<Record<string, unknown>>) => {
    if (filas.length === 0) return;
    const cols = Object.keys(filas[0]);
    const esc = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...filas.map((f) => cols.map((c) => esc(f[c])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = nombre; a.click();
    URL.revokeObjectURL(url);
  };

  const m = useMutation({
    mutationFn: async (nuevos: ClienteNuevo[]) => {
      // De a 200. Un INSERT de 1400 filas en una sola llamada es un payload
      // enorme y, si algo falla, no se sabe qué entró y qué no. En lotes, el
      // error dice exactamente en cuál se cortó.
      const LOTE = 200;
      let hechos = 0;
      for (let i = 0; i < nuevos.length; i += LOTE) {
        const trozo = nuevos.slice(i, i + LOTE);
        const { error: e } = await supabase.from("clientes").insert(trozo);
        if (e) {
          throw new Error(
            `Se crearon ${hechos} de ${nuevos.length} y el lote siguiente falló: ${e.message}. ` +
              `Los ${hechos} que entraron quedaron creados. Volvé a elegir el archivo: la ` +
              `pantalla ya se actualizó con lo que hay en el sistema y sólo va a crear el resto.`,
          );
        }
        hechos += trozo.length;
        setProgreso({ hechos, total: nuevos.length });
      }
      return hechos;
    },
    onSuccess: (n) => { toast.success(`${n} cliente${n === 1 ? "" : "s"} creados`); onImportado(); },
    onError: (e: any) => {
      setProgreso(null);
      // Sin esto, `existentes` sigue siendo la foto vieja y un reintento
      // recalcularía sobre datos que ya cambiaron. Para los que tienen CUIT el
      // índice único los frena; para los que no tienen, se duplicarían.
      qcDialog.invalidateQueries({ queryKey: ["clientes"] });
      setFilas([]); setEncabezados([]);
      toast.error(e.message, { duration: 15000 });
    },
  });

  const noPuede = listaTruncada
    ? "La lista de clientes se cargó incompleta: no se puede chequear duplicados. Recargá la página."
    : leyendo
      ? "Leyendo el archivo…"
      : !res
    ? "Elegí un archivo."
    : !cols.razon_social
      ? "Elegí qué columna tiene el nombre del cliente."
      : res.aCrear.length === 0
        ? "No hay ningún cliente nuevo para crear."
        : null;

  const Linea = ({ n, children, tono = "", accion }: any) => (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-14 text-right font-mono font-semibold ${tono}`}>{n}</span>
      <span className={tono}>{children}</span>
      {accion && n > 0 && (
        <Button size="sm" variant="ghost" className="h-6 px-2" onClick={accion}>
          <Download className="mr-1 h-3 w-3"/> bajar
        </Button>
      )}
    </div>
  );

  return (
    <Dialog open onOpenChange={(v)=>!v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Importar clientes</DialogTitle></DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Archivo (.csv, .xlsx, .xls)</Label>
            <Input type="file" accept=".csv,.xlsx,.xls" data-testid="clientes-archivo"
              onChange={(e)=>{ const f = e.target.files?.[0]; if (f) leerArchivo(f); }}/>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Si tenés el PDF del sistema viejo, convertilo antes con{" "}
              <code className="rounded bg-muted px-1">scripts/clientes-pdf-a-csv.py</code>: verifica
              que no falten páginas.
            </p>
          </div>

          {leyendo && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin"/> Leyendo…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {encabezados.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {([
                ["razon_social", "Nombre / Razón social *"],
                ["cuit", "CUIT / DNI"],
                ["cta_cte", "Cuenta corriente (S/N)"],
                ["domicilio", "Domicilio"],
                ["telefono", "Teléfono"],
              ] as const).map(([campo, label]) => (
                <div key={campo}>
                  <Label className="text-xs">{label}</Label>
                  <Select value={cols[campo] ?? "__none__"}
                    onValueChange={(v)=>setCols((c)=>({ ...c, [campo]: v === "__none__" ? null : v }))}>
                    <SelectTrigger className="h-9" data-testid={`clientes-col-${campo}`}><SelectValue placeholder="Elegí…"/></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— no importar —</SelectItem>
                      {encabezados.map((h)=>(<SelectItem key={h} value={h}>{h}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          {res && (
            <>
              <div className="space-y-1 rounded-lg border border-border p-3">
                <Linea n={res.filasLeidas}>filas leídas</Linea>
                <Linea n={res.aCrear.length} tono="text-success">se van a crear</Linea>
                <Linea n={res.cuitInvalido.length} tono={res.cuitInvalido.length ? "text-destructive" : ""}
                  accion={()=>bajar("cuit-invalido.csv", res.cuitInvalido as any)}>
                  con el CUIT/DNI inválido — hay que corregirlos
                </Linea>
                <Linea n={res.cuitRepetido.length} tono={res.cuitRepetido.length ? "text-warning" : ""}
                  accion={()=>bajar("cuit-repetido.csv", res.cuitRepetido as any)}>
                  con el CUIT repetido en el archivo — se sacan todas
                </Linea>
                <Linea n={res.yaExistenPorCuit.length}
                  accion={()=>bajar("ya-existen.csv", res.yaExistenPorCuit as any)}>
                  ya están en el sistema (mismo CUIT)
                </Linea>
                <Linea n={res.yaExistenPorNombre.length}
                  accion={()=>bajar("ya-existen-por-nombre.csv", res.yaExistenPorNombre.map((n)=>({ razon_social: n })))}>
                  con un nombre que ya existe en el sistema
                </Linea>
                <Linea n={res.nombreRepetido.length} tono={res.nombreRepetido.length ? "text-warning" : ""}
                  accion={()=>bajar("nombre-repetido.csv", res.nombreRepetido.map((n)=>({ razon_social: n })))}>
                  sin CUIT, con el nombre repetido en el archivo
                </Linea>
                {res.sinNombre > 0 && <Linea n={res.sinNombre}>filas sin nombre (ignoradas)</Linea>}
              </div>

              <p className="text-[11px] text-muted-foreground">
                Se importa el nombre, el CUIT, la cuenta corriente, el domicilio y el teléfono.
                <strong> La categoría de IVA no se importa</strong>: todos entran como
                “Consumidor final” y hay que ajustarlo a mano en los que facturen distinto.
              </p>

              {progreso && (
                <p className="text-sm">
                  Creando… <strong>{progreso.hechos}</strong> de {progreso.total}
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center">
          {noPuede && <span className="text-xs text-muted-foreground sm:mr-auto">{noPuede}</span>}
          <Button variant="outline" onClick={onClose} disabled={m.isPending}>Cancelar</Button>
          <Button disabled={!!noPuede || m.isPending} data-testid="clientes-crear"
            onClick={()=>res && m.mutate(res.aCrear)}>
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1"/>}
            Crear {res?.aCrear.length ?? 0} clientes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
