-- ============================================================
-- Precio de venta desde el SUGERIDO AL PÚBLICO del proveedor.
--
-- La lista de Quimex trae una columna "Sugerido al público C/IVA" que el sistema
-- nunca usó: no existía como campo de importación ni como columna acá. El precio
-- de venta se derivaba del costo, y por eso el negocio vendía por DEBAJO del
-- precio que el propio proveedor sugiere (4000-00400: $28.076 en góndola contra
-- $34.370 sugeridos por Quimex).
--
-- Cadena nueva:
--   precio_lista (Quimex, s/IVA)
--     × (1 − descuento_proveedor/100)   = precio_fabrica (COSTO, s/IVA)
--     × (1 + iva/100)                   = lo que se le paga a Quimex (display)
--
--   precio_sugerido_publico (Quimex, C/IVA)
--     × (1 + markup/100)                = precio de venta al público (c/IVA)
--     ÷ (1 + iva/100)                   = precio_sin_iva (lo que se factura)
--
-- Si el producto NO tiene sugerido (otros proveedores no lo mandan), el precio
-- sigue derivándose del costo exactamente como hasta hoy. La derivación se
-- materializa en la app (src/lib/precios.ts), igual que precio_fabrica y
-- precio_sin_iva. Ver docs/superpowers/specs/2026-07-29-precios-sugerido-publico-design.md
--
-- OJO: esta migración NO recalcula ningún precio. Agrega la columna en NULL, así
-- que todos los productos existentes caen en la rama "por costo" y se comportan
-- igual que antes. Los precios cambian recién cuando el negocio vuelva a importar
-- la lista de Quimex con la columna mapeada — subir la góndola ~59% tiene que ser
-- un acto deliberado, no el efecto secundario de un deploy.
-- ============================================================

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS precio_sugerido_publico numeric(14,2);

-- Un sugerido negativo no significa nada y la fórmula lo ignoraría en silencio
-- (la rama pide > 0). Mejor que no se pueda guardar.
DO $$ BEGIN
  ALTER TABLE public.productos
    ADD CONSTRAINT productos_precio_sugerido_publico_no_negativo
    CHECK (precio_sugerido_publico IS NULL OR precio_sugerido_publico >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.productos.precio_sugerido_publico IS
  'Precio sugerido al público que publica el proveedor en su lista, CON IVA incluido. NULL = la lista no lo trae. Cuando existe, el precio de venta se deriva de acá: precio_sin_iva = precio_sugerido_publico × (1 + markup/100) / (1 + iva/100). Si es NULL, el precio se deriva del costo como antes.';

-- El negocio trabaja con 30%. La tabla se creó con DEFAULT 50 (20260630021321) y
-- producción ya tiene 30 cargado en su fila; esto alinea las instalaciones nuevas.
-- Deliberadamente NO se hace UPDATE de la fila existente: cambiar el markup de un
-- catálogo ya cargado es una decisión del negocio, no de una migración.
ALTER TABLE public.settings
  ALTER COLUMN markup_default_porcentaje SET DEFAULT 30;
