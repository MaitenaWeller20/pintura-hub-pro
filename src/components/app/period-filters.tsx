import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PeriodFilters({
  from,
  to,
  onFrom,
  onTo,
  sucursalId,
  onSucursal,
  sucursales,
  children,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  sucursalId?: string;
  onSucursal?: (v: string) => void;
  sucursales?: Array<{ id: string; nombre: string }>;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 mb-4">
      <div className="space-y-1">
        <Label className="text-xs">Desde</Label>
        <Input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="w-auto" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Hasta</Label>
        <Input type="date" value={to} onChange={(e) => onTo(e.target.value)} className="w-auto" />
      </div>
      {sucursales && onSucursal && (
        <div className="space-y-1">
          <Label className="text-xs">Sucursal</Label>
          <Select value={sucursalId || "__all__"} onValueChange={(v) => onSucursal(v === "__all__" ? "" : v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Todas</SelectItem>
              {sucursales.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {children}
    </div>
  );
}
