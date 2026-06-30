/**
 * Input numérico que permite borrar el contenido (string vacío)
 * sin saltar a 0. Devuelve number | null vía onValueChange.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: number | null | undefined;
  onValueChange: (v: number | null) => void;
  allowNegative?: boolean;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ value, onValueChange, allowNegative = false, className, ...rest }, ref) => {
    // Estado local en string para permitir vacío
    const [text, setText] = React.useState<string>(
      value === null || value === undefined || Number.isNaN(value) ? "" : String(value)
    );
    // Sincronizar cuando el valor externo cambia y no estoy editando
    const [focused, setFocused] = React.useState(false);
    React.useEffect(() => {
      if (focused) return;
      const next = value === null || value === undefined || Number.isNaN(value) ? "" : String(value);
      if (next !== text) setText(next);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, focused]);

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="decimal"
        className={cn(className)}
        value={text}
        onFocus={(e) => { setFocused(true); rest.onFocus?.(e); }}
        onBlur={(e) => {
          setFocused(false);
          // Normalizar al perder foco
          const n = text === "" || text === "-" ? null : Number(text.replace(",", "."));
          if (n === null) {
            onValueChange(null);
            setText("");
          } else if (!Number.isNaN(n)) {
            onValueChange(n);
            setText(String(n));
          }
          rest.onBlur?.(e);
        }}
        onChange={(e) => {
          const raw = e.target.value;
          // Aceptar vacío, signo opcional, dígitos y separador decimal único
          const re = allowNegative ? /^-?\d*[.,]?\d*$/ : /^\d*[.,]?\d*$/;
          if (raw === "" || re.test(raw)) {
            setText(raw);
            if (raw === "" || raw === "-") {
              onValueChange(null);
            } else {
              const n = Number(raw.replace(",", "."));
              if (!Number.isNaN(n)) onValueChange(n);
            }
          }
        }}
        {...rest}
      />
    );
  }
);
NumberInput.displayName = "NumberInput";
