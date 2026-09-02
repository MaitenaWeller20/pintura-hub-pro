-- La frontera de columnas de 20260826193000 oculta `afip_error` a operadores.
-- Las columnas operativas de NC por período nacieron después y, al no quedar en
-- aquella allowlist, una proyección explícita del listado de Ventas falla entera
-- con 42501. Se habilitan sólo los campos que la UI segura consume; el texto
-- técnico y el hash de idempotencia siguen reservados al backend.

GRANT SELECT (
  motivo_nota_credito,
  nc_efectos_aplicados_at,
  nc_periodo_modalidad,
  nc_resolucion,
  periodo_asoc_desde,
  periodo_asoc_hasta
) ON TABLE public.ventas TO authenticated;

COMMENT ON COLUMN public.ventas.nc_periodo_payload_hash IS
  'Hash técnico de idempotencia reservado al backend; no forma parte de la proyección de operadores.';
