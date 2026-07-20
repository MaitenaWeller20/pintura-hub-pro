-- ============================================================
-- Precios: descuento de proveedor (Quimex) + precio de lista.
--
-- Hoy el sistema solo tiene precio_fabrica (costo) y markup. Pero CasaForma recibe
-- de Quimex una LISTA DE PRECIOS y le compra con un descuento comercial (~42%). El
-- costo real es entonces: costo = precio_lista × (1 - descuento/100). Ese cálculo
-- se hacía en un Excel externo; ahora lo hace el sistema.
--
-- Cadena de precios:
--   precio_lista (de Quimex)
--     × (1 - descuento_proveedor/100)  = precio_fabrica (COSTO)
--     × (1 + markup/100)               = precio_sin_iva (VENTA neto)
--     × (1 + iva/100)                  = precio final c/IVA
--
-- La derivación se materializa en la app (importación / alta-edición de producto),
-- igual que ya se hace con precio_sin_iva. El descuento es global (settings): el
-- descuento comercial de Quimex es el mismo para toda su lista.
-- ============================================================

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS descuento_proveedor_porcentaje numeric(6,2) NOT NULL DEFAULT 42;

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS precio_lista numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.productos.precio_lista IS
  'Precio de lista del proveedor (Quimex), SIN el descuento comercial. El costo (precio_fabrica) se deriva: precio_lista × (1 - settings.descuento_proveedor_porcentaje/100).';
COMMENT ON COLUMN public.settings.descuento_proveedor_porcentaje IS
  'Descuento comercial que el proveedor (Quimex) le hace a CasaForma sobre el precio de lista. Se usa para derivar el costo (precio_fabrica) desde precio_lista.';
