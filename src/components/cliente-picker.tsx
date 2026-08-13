import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { filtroNombreODocumento, fmtDocumento } from "@/lib/documento";

/**
 * Buscador de clientes contra el servidor.
 *
 * El `<Select>` que había antes cargaba los primeros 500 clientes y filtraba en
 * memoria: el 501 no se podía elegir y nada avisaba. Acá la búsqueda la hace
 * PostgREST y sólo bajan 15 filas.
 */
export function ClientePicker({
  value,
  onChange,
  testId,
  placeholder = "Buscar cliente…",
  permitirVacio,
}: {
  value: string;
  onChange: (id: string) => void;
  testId?: string;
  placeholder?: string;
  permitirVacio?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [q, setQ] = useState("");

  const { data: clientes = [] } = useQuery({
    queryKey: ["clientes-buscar", q],
    queryFn: async () => {
      let sel = supabase
        .from("clientes")
        .select("id, razon_social, cuit_dni")
        .eq("activo", true)
        .order("razon_social")
        .limit(15);
      // El CUIT se busca por sus dígitos (así entra escrito con o sin guiones) y
      // el nombre va entrecomillado, para que una coma no parta el filtro.
      const filtro = filtroNombreODocumento(q);
      if (filtro) sel = sel.or(filtro);
      return ((await sel).data ?? []) as any[];
    },
  });

  // El elegido puede no estar en los 15 de la búsqueda actual, así que su
  // nombre se pide aparte.
  const { data: elegido } = useQuery({
    queryKey: ["cliente", value],
    enabled: !!value,
    queryFn: async () =>
      (await supabase.from("clientes").select("id, razon_social").eq("id", value).maybeSingle())
        .data as any,
  });

  const etiqueta = useMemo(
    () => elegido?.razon_social ?? (value ? "…" : placeholder),
    [elegido, value, placeholder],
  );

  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start font-normal"
          data-testid={testId}
        >
          {etiqueta}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[92vw] sm:w-[380px] p-2">
        <Input
          placeholder="Nombre o CUIT…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="max-h-64 overflow-auto mt-2">
          {permitirVacio && (
            <button
              type="button"
              className="w-full text-left p-2 hover:bg-accent rounded text-sm text-muted-foreground"
              onClick={() => {
                onChange("");
                setAbierto(false);
              }}
            >
              Sin cliente (escribo el nombre a mano)
            </button>
          )}
          {clientes.map((c: any) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={c.id === value}
              className="w-full text-left p-2 hover:bg-accent rounded text-sm"
              onClick={() => {
                onChange(c.id);
                setAbierto(false);
              }}
            >
              <div className="font-medium">{c.razon_social}</div>
              {c.cuit_dni && (
                <div className="text-xs text-muted-foreground">{fmtDocumento(c.cuit_dni)}</div>
              )}
            </button>
          ))}
          {clientes.length === 0 && (
            <p className="text-sm text-muted-foreground p-2">
              {q ? "Ningún cliente con ese nombre o CUIT." : "Escribí para buscar."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
