import { useState } from "react";
import { Filter, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BusquedaColaFiscal } from "@/lib/fiscal/cola-ui";

type Opcion = { id: string; nombre: string };

export function ColaFiscalFiltros({
  initial,
  esAdmin,
  sucursales,
  emisores,
  disabled = false,
  onAplicar,
  onLimpiar,
}: {
  initial: BusquedaColaFiscal;
  esAdmin: boolean;
  sucursales: Opcion[];
  emisores: Array<{ id: string; razon_social: string; cuit: string | null }>;
  disabled?: boolean;
  onAplicar(filtros: Partial<BusquedaColaFiscal>): void;
  onLimpiar(): void;
}) {
  const [draft, setDraft] = useState({
    desde: initial.desde ?? "",
    hasta: initial.hasta ?? "",
    sucursal: initial.sucursal ?? "",
    emisor: initial.emisor ?? "",
    documento: initial.documento ?? "",
    estado: initial.estado ?? "",
  });
  const cambiar = (key: keyof typeof draft, value: string) =>
    setDraft((actual) => ({ ...actual, [key]: value }));

  return (
    <form
      className="rounded-xl border border-border bg-card p-4 shadow-card"
      onSubmit={(event) => {
        event.preventDefault();
        onAplicar({
          desde: draft.desde || undefined,
          hasta: draft.hasta || undefined,
          sucursal: esAdmin ? draft.sucursal || undefined : undefined,
          emisor: esAdmin ? draft.emisor || undefined : undefined,
          documento: draft.documento.trim() || undefined,
          estado: draft.estado || undefined,
        });
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Filter className="h-4 w-4 text-primary" /> Filtros del libro fiscal
        </legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <Label htmlFor="cola-desde">Desde</Label>
            <Input
              id="cola-desde"
              type="date"
              className="mt-1 min-h-11"
              value={draft.desde}
              onChange={(event) => cambiar("desde", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cola-hasta">Hasta</Label>
            <Input
              id="cola-hasta"
              type="date"
              className="mt-1 min-h-11"
              value={draft.hasta}
              onChange={(event) => cambiar("hasta", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cola-documento">Documento receptor</Label>
            <Input
              id="cola-documento"
              inputMode="numeric"
              className="mt-1 min-h-11"
              placeholder="CUIT, CUIL o DNI"
              value={draft.documento}
              onChange={(event) => cambiar("documento", event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cola-estado">Estado</Label>
            <select
              id="cola-estado"
              className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={draft.estado}
              onChange={(event) => cambiar("estado", event.target.value)}
            >
              <option value="">Todos</option>
              <option value="SIN_FACTURAR">Sin facturar</option>
              <option value="EMITIENDO">Emitiendo</option>
              <option value="ERROR_CORREGIBLE">Error corregible</option>
              <option value="RECONCILIAR">Conciliar</option>
              <option value="BLOQUEADO">Bloqueado</option>
              <option value="APROBADO">Aprobado</option>
              <option value="CANCELADO">Cancelado</option>
              <option value="PENDIENTE">Legacy pendiente</option>
              <option value="ERROR">Legacy con error</option>
            </select>
          </div>
          {esAdmin ? (
            <div>
              <Label htmlFor="cola-sucursal">Sucursal</Label>
              <select
                id="cola-sucursal"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft.sucursal}
                onChange={(event) => cambiar("sucursal", event.target.value)}
              >
                <option value="">Todas</option>
                {sucursales.map((sucursal) => (
                  <option key={sucursal.id} value={sucursal.id}>
                    {sucursal.nombre}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {esAdmin ? (
            <div>
              <Label htmlFor="cola-emisor">Emisor</Label>
              <select
                id="cola-emisor"
                className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={draft.emisor}
                onChange={(event) => cambiar("emisor", event.target.value)}
              >
                <option value="">Todos</option>
                {emisores.map((emisor) => (
                  <option key={emisor.id} value={emisor.id}>
                    {emisor.razon_social} · {emisor.cuit ?? "sin CUIT"}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 w-full sm:w-auto"
            onClick={onLimpiar}
          >
            <RotateCcw /> Limpiar
          </Button>
          <Button type="submit" className="min-h-11 w-full sm:w-auto">
            <Search /> Aplicar filtros
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
