-- Permite corregir un remito interno antes de que el destino lo procese.
--
-- La edición vive en una única RPC porque remitos + remito_items tienen que
-- cambiar juntos. La misma fila de remitos se bloquea primero tanto acá como
-- en aprobar_remito/rechazar_remito: editar y procesar concurrentemente queda
-- serializado y nunca mueve stock con un detalle a medio guardar.
CREATE OR REPLACE FUNCTION public.editar_remito(
  p_remito_id uuid,
  p_sucursal_destino_id uuid,
  p_observaciones text,
  p_items jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_remito  public.remitos%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Siempre se bloquea el encabezado antes que los ítems. Aprobar y rechazar
  -- usan el mismo orden, lo que evita carreras y deadlocks entre operaciones.
  SELECT * INTO v_remito
    FROM public.remitos
   WHERE id = p_remito_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Remito inexistente';
  END IF;

  IF v_remito.estado <> 'PENDIENTE' THEN
    RAISE EXCEPTION 'El remito % ya fue procesado (estado %)',
      v_remito.numero, v_remito.estado;
  END IF;

  -- Corrige la sucursal que envía el remito; el destino sólo decide si lo
  -- acepta o rechaza. El administrador conserva el override operativo.
  IF NOT (
    public.is_admin(v_uid)
    OR public.current_sucursal_id() IS NOT DISTINCT FROM v_remito.sucursal_origen_id
  ) THEN
    RAISE EXCEPTION 'Sólo la sucursal de origen (o un administrador) puede editar este remito';
  END IF;

  IF p_sucursal_destino_id IS NULL THEN
    RAISE EXCEPTION 'La sucursal de destino es obligatoria';
  END IF;

  IF p_sucursal_destino_id = v_remito.sucursal_origen_id THEN
    RAISE EXCEPTION 'Origen y destino deben ser distintos';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'El remito debe tener al menos un producto';
  END IF;

  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'El remito no puede tener más de 500 productos';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_to_recordset(p_items) AS i(producto_id uuid, cantidad numeric)
     WHERE i.producto_id IS NULL OR i.cantidad IS NULL OR i.cantidad <= 0
  ) THEN
    RAISE EXCEPTION 'Todos los productos y cantidades del remito deben ser válidos';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT i.producto_id)
      FROM jsonb_to_recordset(p_items) AS i(producto_id uuid, cantidad numeric)
  ) THEN
    RAISE EXCEPTION 'Un producto no puede repetirse en el mismo remito';
  END IF;

  UPDATE public.remitos
     SET sucursal_destino_id = p_sucursal_destino_id,
         observaciones = NULLIF(btrim(p_observaciones), '')
   WHERE id = p_remito_id;

  DELETE FROM public.remito_items
   WHERE remito_id = p_remito_id;

  INSERT INTO public.remito_items (remito_id, producto_id, cantidad)
  SELECT p_remito_id, i.producto_id, i.cantidad
    FROM jsonb_to_recordset(p_items) AS i(producto_id uuid, cantidad numeric);
END;
$$;

-- SECURITY DEFINER es necesario para reemplazar los ítems pese a la RLS, pero
-- la función autentica y autoriza por sucursal antes de escribir.
REVOKE ALL ON FUNCTION public.editar_remito(uuid, uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.editar_remito(uuid, uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.editar_remito(uuid, uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.editar_remito(uuid, uuid, text, jsonb) IS
  'Edita destino, observaciones e ítems de un remito PENDIENTE. Sólo origen o admin; no mueve stock.';
