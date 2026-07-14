import type { ReactNode } from "react";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export function DataTable({
  columns,
  children,
  loading,
  error,
  onRetry,
  empty,
  isEmpty,
}: {
  columns: string[];
  children: ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  empty?: { text: string; icon?: ReactNode; action?: ReactNode };
  /** La página indica si no hay filas (no lo inferimos de `children`). */
  isEmpty?: boolean;
}) {
  const renderBody = () => {
    if (loading) {
      return [...Array(5)].map((_, i) => (
        <TableRow key={i}>
          {columns.map((_c, j) => (
            <TableCell key={j}>
              <div className="h-4 rounded bg-muted animate-pulse" />
            </TableCell>
          ))}
        </TableRow>
      ));
    }
    if (error) {
      return (
        <TableRow>
          <TableCell colSpan={columns.length} className="text-center py-8 text-sm text-destructive">
            {error}
            {onRetry && (
              <Button size="sm" variant="outline" className="ml-2" onClick={onRetry}>
                Reintentar
              </Button>
            )}
          </TableCell>
        </TableRow>
      );
    }
    if (isEmpty && empty) {
      return (
        <TableRow>
          <TableCell colSpan={columns.length} className="text-center py-10">
            {empty.icon && <div className="flex justify-center mb-2 text-muted-foreground/60">{empty.icon}</div>}
            <p className="text-sm text-muted-foreground">{empty.text}</p>
            {empty.action && <div className="mt-3 flex justify-center">{empty.action}</div>}
          </TableCell>
        </TableRow>
      );
    }
    return children;
  };

  return (
    <div className="rounded-2xl border border-border overflow-hidden shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>{renderBody()}</TableBody>
        </Table>
      </div>
    </div>
  );
}
