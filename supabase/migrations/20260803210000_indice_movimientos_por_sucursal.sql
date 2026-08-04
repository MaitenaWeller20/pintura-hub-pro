-- ============================================================
-- Índice para "¿hubo movimientos en esta sucursal después de tal fecha?"
--
-- Lo pide la importación de conteo: cuando se sube un archivo, la pantalla
-- cuenta los movimientos de stock posteriores a la foto que trae el archivo,
-- porque lo que se cargue los va a pisar y hay que avisarlo con el número.
--
-- `stock_movimientos` tiene índices por (producto_id, sucursal_id) y por
-- (producto_id, created_at), pero ninguno que sirva para filtrar por SUCURSAL y
-- fecha sin mirar producto. Sin esto, ese conteo escanea la tabla entera — hoy
-- es chica, pero el kardex es la tabla que más crece de todo el sistema y esta
-- consulta corre justo al abrir el importador.
--
-- Ver docs/superpowers/specs/2026-08-03-importar-conteo-design.md
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stock_mov_sucursal_fecha
  ON public.stock_movimientos (sucursal_id, created_at DESC);
