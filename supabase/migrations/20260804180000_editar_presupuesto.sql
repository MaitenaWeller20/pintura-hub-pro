-- ============================================================
-- Editar un presupuesto.
--
-- Hasta hoy se podía ver, imprimir, anular y convertir en venta. Editar no
-- existía: corregir una cantidad obligaba a anular y rehacerlo entero, con
-- número nuevo, y el cliente recibía dos papeles distintos por lo mismo.
--
-- Ver docs/superpowers/specs/2026-08-04-cuatro-correcciones-de-uso-design.md
--
-- LA DECISIÓN QUE IMPORTA: qué pasa con los precios.
--
-- `crear_presupuesto` deriva cada precio del catálogo. Si `editar` hiciera lo
-- mismo, cambiar UNA cantidad repreciaría el presupuesto ENTERO con la lista de
-- hoy: alguien corrige un 3 por un 5 y sin querer le manda al cliente otros
-- precios en las otras seis líneas.
--
-- Y no sería sólo cosmético. `convertir_presupuesto_en_venta` factura con
-- `presupuesto_items.precio_sin_iva` —el snapshot, no el catálogo—, así que
-- repreciar al editar cambiaría lo que se le cobra al cliente.
--
-- Por eso: se CONSERVA el precio de las líneas que ya estaban, y sólo las
-- líneas nuevas toman el precio de hoy. Repreciar es una acción explícita
-- (`p_repreciar`), que la pantalla ofrece únicamente cuando algo se movió.
-- ============================================================

CREATE OR REPLACE FUNCTION public.editar_presupuesto(
  p_presupuesto_id uuid,
  p_items          jsonb,
  p_cliente_id     uuid    DEFAULT NULL,
  p_nombre_cliente text    DEFAULT NULL,
  p_validez_hasta  date    DEFAULT NULL,
  p_observaciones  text    DEFAULT NULL,
  p_repreciar      boolean DEFAULT false
)
RETURNS TABLE (presupuesto_id uuid, numero text, total numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_p      public.presupuestos%ROWTYPE;
  v_sub    numeric(14,2) := 0;
  v_iva    numeric(14,2) := 0;
  it       jsonb;
  v_prod   public.productos%ROWTYPE;
  v_pid    uuid;
  v_cant   numeric(14,2);
  v_desc   numeric(5,2);
  v_lista  numeric(14,2);
  v_ivapct numeric(5,2);
  v_precio numeric(14,2);
  v_si     numeric(14,2);
  v_ii     numeric(14,2);
  v_calc   jsonb := '[]'::jsonb;
  v_previo jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- FOR UPDATE, igual que anular y que convertir. Los tres toman la misma fila
  -- primero, así que quedan serializados entre sí: no se puede convertir un
  -- presupuesto mientras se lo edita, ni al revés.
  SELECT * INTO v_p FROM public.presupuestos WHERE id = p_presupuesto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Presupuesto no encontrado'; END IF;

  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés editar un presupuesto de otra sucursal';
  END IF;
  IF v_p.estado = 'CONVERTIDO' THEN
    RAISE EXCEPTION 'Este presupuesto ya se convirtió en la venta %. Para cambiarlo hay que anular la venta.',
      COALESCE((SELECT v.numero_comprobante FROM public.ventas v WHERE v.id = v_p.venta_id), 's/n');
  END IF;
  IF v_p.estado = 'ANULADO' THEN
    RAISE EXCEPTION 'Este presupuesto está anulado. Hacé uno nuevo.';
  END IF;

  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un producto. Si querés dejarlo sin nada, anulalo.';
  END IF;
  IF p_cliente_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  -- El mismo producto dos veces haría ambiguo de cuál de las dos líneas sale el
  -- precio guardado. La pantalla ya lo impide; acá se cierra la puerta.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_items) x
     GROUP BY x->>'producto_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Hay un producto repetido: juntá las cantidades en una sola línea';
  END IF;

  -- EL SNAPSHOT: lo que este presupuesto ya le prometió al cliente.
  -- DISTINCT ON porque nada en la tabla impide hoy dos líneas del mismo
  -- producto, y sin esto el jsonb_object_agg reventaría con una clave repetida.
  SELECT COALESCE(
           jsonb_object_agg(t.producto_id,
             jsonb_build_object('lista', t.precio_lista_sin_iva, 'iva', t.iva_porcentaje)),
           '{}'::jsonb)
    INTO v_previo
    FROM (SELECT DISTINCT ON (i.producto_id)
                 i.producto_id, i.precio_lista_sin_iva, i.iva_porcentaje
            FROM public.presupuesto_items i
           WHERE i.presupuesto_id = p_presupuesto_id
           ORDER BY i.producto_id, i.id) t;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_pid := (it->>'producto_id')::uuid;

    SELECT * INTO v_prod FROM public.productos WHERE id = v_pid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'El producto % ya no existe', v_pid;
    END IF;

    -- Un producto que YA ESTABA se acepta aunque hoy esté archivado o inactivo:
    -- ya está en el papel que se le mandó al cliente. Rechazarlo dejaría el
    -- presupuesto imposible de editar para siempre — ni siquiera para SACAR esa
    -- línea, que es justo lo que haría falta. Uno que se agrega ahora se valida
    -- como en `crear_presupuesto`.
    IF NOT (v_prod.activo AND NOT v_prod.archivado) AND NOT (v_previo ? v_pid::text) THEN
      RAISE EXCEPTION 'El producto % está inactivo o archivado: no se puede agregar', v_prod.codigo;
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    -- NaN se chequea explícito: `NaN <= 0` es false y `NaN > 0` es true, así que
    -- ninguna comparación normal lo atrapa.
    IF v_cant IS NULL OR v_cant = 'NaN'::numeric OR v_cant <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida en el producto %', v_prod.codigo;
    END IF;

    v_desc := COALESCE((it->>'descuento_porcentaje')::numeric, 0);
    IF v_desc = 'NaN'::numeric OR v_desc < 0 OR v_desc > 100 THEN
      RAISE EXCEPTION 'Descuento inválido (%) en el producto %', v_desc, v_prod.codigo;
    END IF;

    -- El precio y el IVA viajan JUNTOS, del snapshot o del catálogo, nunca
    -- mezclados: un neto viejo con el IVA de hoy no es ninguno de los dos
    -- presupuestos y no coincidiría con el papel ni con la lista.
    IF NOT p_repreciar AND (v_previo ? v_pid::text) THEN
      v_lista  := (v_previo -> v_pid::text ->> 'lista')::numeric;
      v_ivapct := (v_previo -> v_pid::text ->> 'iva')::numeric;
    ELSE
      v_lista  := v_prod.precio_sin_iva;
      v_ivapct := v_prod.iva_porcentaje;
    END IF;

    v_precio := ROUND(v_lista * (1 - v_desc / 100), 2);
    v_si := ROUND(v_precio * v_cant, 2);
    v_ii := ROUND(v_si * v_ivapct / 100, 2);
    v_sub := v_sub + v_si;
    v_iva := v_iva + v_ii;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'lista', v_lista, 'descuento', v_desc,
      'precio', v_precio, 'iva_pct', v_ivapct, 'si', v_si, 'ii', v_ii);
  END LOOP;

  -- Borrar y reinsertar en vez de diferenciar línea por línea: ninguna FK apunta
  -- a presupuesto_items, así que sus id no son un dato que nadie tenga guardado.
  --
  -- El alias `i` NO es decorativo: `RETURNS TABLE (presupuesto_id ...)` declara
  -- una variable con ese nombre, y sin calificar la columna Postgres corta con
  -- "column reference presupuesto_id is ambiguous".
  DELETE FROM public.presupuesto_items i WHERE i.presupuesto_id = p_presupuesto_id;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, codigo, descripcion, cantidad,
      precio_lista_sin_iva, descuento_porcentaje, precio_sin_iva,
      iva_porcentaje, subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      p_presupuesto_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion',
      (it->>'cantidad')::numeric, (it->>'lista')::numeric, (it->>'descuento')::numeric,
      (it->>'precio')::numeric, (it->>'iva_pct')::numeric,
      (it->>'si')::numeric, (it->>'ii')::numeric,
      ROUND((it->>'si')::numeric + (it->>'ii')::numeric, 2));
  END LOOP;

  -- numero, fecha y usuario_id NO se tocan: es el mismo documento. Cambiarle el
  -- número dejaría al cliente con dos papeles que dicen cosas distintas.
  UPDATE public.presupuestos
     SET cliente_id       = p_cliente_id,
         nombre_cliente   = p_nombre_cliente,
         validez_hasta    = p_validez_hasta,
         observaciones    = p_observaciones,
         subtotal_sin_iva = v_sub,
         iva_total        = v_iva,
         total            = ROUND(v_sub + v_iva, 2)
   WHERE id = p_presupuesto_id;

  RETURN QUERY SELECT v_p.id, v_p.numero, ROUND(v_sub + v_iva, 2);
END; $$;

REVOKE ALL ON FUNCTION public.editar_presupuesto(uuid, jsonb, uuid, text, date, text, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.editar_presupuesto(uuid, jsonb, uuid, text, date, text, boolean)
  TO authenticated, service_role;
