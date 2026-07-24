-- ============================================================
-- confirmar_ingreso_mercaderia: rechazar productos ARCHIVADOS.
--
-- La RPC es autoritativa y la puede llamar un no-admin (para su sucursal). Los
-- pickers ya excluyen archivados, pero un payload stale o una llamada directa
-- podría sumar stock a un producto eliminado (archivado) y crear "stock oculto".
-- Se agrega el guard: un producto archivado no puede recibir mercadería.
-- (SÍ sigue aceptando inactivos-sin-precio, que no están archivados.)
--
-- Es CREATE OR REPLACE de la función que ya está en prod (20260724110000): sólo
-- cambia el agregado del IF v_prod.archivado. El resto es idéntico.
-- ============================================================
CREATE OR REPLACE FUNCTION public.confirmar_ingreso_mercaderia(
  p_ingreso_id     uuid,
  p_numero         text  DEFAULT NULL,
  p_fecha          date  DEFAULT NULL,
  p_items          jsonb DEFAULT NULL,
  p_observaciones  text  DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_ing        public.ingresos_mercaderia%ROWTYPE;
  v_ex_id      uuid;
  v_num_norm   text := public.normalizar_codigo(p_numero);
  it           jsonb;
  v_prod       public.productos%ROWTYPE;
  v_cant       numeric(14,2);
  v_cod_prov   text;
  v_stock_ant  numeric(14,2);
  v_stock_nue  numeric(14,2);
  v_n_items    integer := 0;
  v_linea      integer := 0;
  v_dup        text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
    SELECT id INTO v_ex_id FROM public.ingresos_mercaderia
      WHERE idempotency_key = p_idempotency_key AND id = p_ingreso_id;
    IF FOUND THEN RETURN v_ex_id; END IF;
  END IF;

  SELECT * INTO v_ing FROM public.ingresos_mercaderia WHERE id = p_ingreso_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ingreso no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_ing.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés confirmar un ingreso de otra sucursal';
  END IF;
  IF v_ing.estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'El ingreso ya fue % (sólo se confirma un borrador)', lower(v_ing.estado);
  END IF;

  IF v_ing.bloqueo_confirmacion IS NOT NULL THEN
    RAISE EXCEPTION '%', v_ing.bloqueo_confirmacion;
  END IF;

  IF p_items IS NOT NULL THEN
    PERFORM public.actualizar_items_borrador(p_ingreso_id, p_items);
  END IF;

  SELECT public.normalizar_codigo(codigo_proveedor) INTO v_dup
    FROM public.ingreso_mercaderia_items
   WHERE ingreso_id = p_ingreso_id AND origen_match <> 'IGNORADA'
     AND public.normalizar_codigo(codigo_proveedor) IS NOT NULL AND producto_id IS NOT NULL
   GROUP BY public.normalizar_codigo(codigo_proveedor)
  HAVING count(DISTINCT producto_id) > 1
   LIMIT 1;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'El código % del proveedor apunta a dos productos distintos en el mismo remito', v_dup;
  END IF;

  FOR it IN
    SELECT to_jsonb(t) FROM public.ingreso_mercaderia_items t
     WHERE t.ingreso_id = p_ingreso_id AND t.origen_match <> 'IGNORADA'
     ORDER BY t.linea
  LOOP
    v_linea    := COALESCE((it->>'linea')::integer, v_linea + 1);
    v_cant     := NULLIF(it->>'cantidad', '')::numeric;
    v_cod_prov := it->>'codigo_proveedor';

    IF (it->>'producto_id') IS NULL OR (it->>'producto_id') = '' THEN
      RAISE EXCEPTION 'La línea % no tiene producto asignado', v_linea;
    END IF;
    IF v_cant IS NULL OR v_cant <= 0 THEN
      RAISE EXCEPTION 'La línea % tiene una cantidad inválida (%)', v_linea, v_cant;
    END IF;

    -- NO se exige activo (un inactivo-sin-precio puede recibir), pero SÍ se rechaza
    -- un producto ARCHIVADO (eliminado): no se le suma stock oculto.
    SELECT * INTO v_prod FROM public.productos WHERE id = (it->>'producto_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La línea % apunta a un producto inexistente', v_linea;
    END IF;
    IF v_prod.archivado THEN
      RAISE EXCEPTION 'La línea % apunta a un producto eliminado (archivado): %', v_linea, v_prod.codigo;
    END IF;

    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
    VALUES (v_prod.id, v_ing.sucursal_id, v_cant)
    ON CONFLICT (producto_id, sucursal_id)
    DO UPDATE SET cantidad = stock_sucursal.cantidad + EXCLUDED.cantidad
    RETURNING cantidad - v_cant, cantidad INTO v_stock_ant, v_stock_nue;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_prod.id, v_ing.sucursal_id, 'INGRESO_MERCADERIA', v_cant, v_stock_ant, v_stock_nue,
      'Ingreso remito ' || COALESCE(p_numero, v_ing.numero_remito_proveedor, ''), p_ingreso_id, v_uid
    );

    IF public.normalizar_codigo(v_cod_prov) IS NOT NULL AND COALESCE((it->>'aprender')::boolean, true) THEN
      IF COALESCE((it->>'pisar_equivalencia')::boolean, false) THEN
        INSERT INTO public.producto_codigos_proveedor (
          proveedor_id, codigo_proveedor, producto_id, descripcion_proveedor, usuario_id
        ) VALUES (
          v_ing.proveedor_id, v_cod_prov, v_prod.id, it->>'descripcion_proveedor', v_uid
        )
        ON CONFLICT (proveedor_id, codigo_proveedor_norm)
        DO UPDATE SET producto_id = EXCLUDED.producto_id,
                      codigo_proveedor = EXCLUDED.codigo_proveedor,
                      descripcion_proveedor = EXCLUDED.descripcion_proveedor,
                      usuario_id = EXCLUDED.usuario_id,
                      updated_at = now();
      ELSE
        INSERT INTO public.producto_codigos_proveedor (
          proveedor_id, codigo_proveedor, producto_id, descripcion_proveedor, usuario_id
        ) VALUES (
          v_ing.proveedor_id, v_cod_prov, v_prod.id, it->>'descripcion_proveedor', v_uid
        )
        ON CONFLICT (proveedor_id, codigo_proveedor_norm) DO NOTHING;
      END IF;
    END IF;

    v_n_items := v_n_items + 1;
  END LOOP;

  IF v_n_items = 0 THEN
    RAISE EXCEPTION 'El ingreso no tiene líneas para cargar';
  END IF;

  UPDATE public.ingresos_mercaderia SET
    estado                  = 'CONFIRMADO',
    numero_remito_proveedor = COALESCE(p_numero, numero_remito_proveedor),
    numero_normalizado      = COALESCE(v_num_norm, numero_normalizado),
    fecha_remito            = COALESCE(p_fecha, fecha_remito),
    observaciones           = COALESCE(p_observaciones, observaciones),
    fecha_confirmacion      = now(),
    idempotency_key         = p_idempotency_key
  WHERE id = p_ingreso_id;

  RETURN p_ingreso_id;
END; $$;
