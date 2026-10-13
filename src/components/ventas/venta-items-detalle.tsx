import { DataTable } from "@/components/app/data-table";
import { TableCell, TableRow } from "@/components/ui/table";
import { fmtMoney, fmtNum } from "@/lib/format";
import { conIva, precioFinalConDescuento } from "@/lib/fiscal/iva";

export interface VentaItemDetalle {
  codigo?: string | null;
  descripcion?: string | null;
  cantidad: number | string;
  precio_unitario_sin_iva: number | string;
  descuento_porcentaje?: number | string | null;
  iva_porcentaje?: number | string | null;
  subtotal_con_iva: number | string;
}

export function VentaItemsDetalle({
  items,
}: {
  tipoComprobante: string;
  items: VentaItemDetalle[];
}) {
  return (
    <DataTable
      columns={[
        "Cód.",
        "Descripción",
        "Cant.",
        "Precio de lista",
        "Desc.",
        "Precio final",
        "Subtotal",
      ]}
    >
      {items.map((item, index) => {
        const descuento = Math.min(Math.max(Number(item.descuento_porcentaje ?? 0), 0), 100);
        const precioLista = conIva(item.precio_unitario_sin_iva, item.iva_porcentaje);
        const precioFinal = precioFinalConDescuento(
          item.precio_unitario_sin_iva,
          descuento,
          item.iva_porcentaje,
        );

        return (
          <TableRow key={index}>
            <TableCell className="font-mono text-xs">{item.codigo}</TableCell>
            <TableCell>{item.descripcion}</TableCell>
            <TableCell className="text-right">{item.cantidad}</TableCell>
            <TableCell className="text-right font-mono">{fmtMoney(precioLista)}</TableCell>
            <TableCell className="text-right font-mono">
              {descuento > 0 ? `${fmtNum(descuento)}%` : "—"}
            </TableCell>
            <TableCell className="text-right font-mono font-medium">
              {fmtMoney(precioFinal)}
            </TableCell>
            <TableCell className="text-right font-mono font-semibold">
              {fmtMoney(item.subtotal_con_iva)}
            </TableCell>
          </TableRow>
        );
      })}
    </DataTable>
  );
}
