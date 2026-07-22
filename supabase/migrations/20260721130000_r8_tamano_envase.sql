-- ============================================================
-- R8 — Tamaño de envase en productos.
--
-- El Excel de precios de Quimex trae una columna ENV (1, 5, 20, 200) con el
-- tamaño del envase (litros/kg según el producto). No existía dónde guardarla.
-- Se agrega una columna numérica nullable (no todo producto tiene envase). La
-- unidad se infiere de unidad_medida existente; no se agrega columna de unidad.
-- ============================================================

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS tamano_envase numeric(10,2);

COMMENT ON COLUMN public.productos.tamano_envase IS
  'Tamaño del envase (columna ENV del Excel de Quimex): 1, 5, 20, 200… en la unidad de unidad_medida. Nullable.';
