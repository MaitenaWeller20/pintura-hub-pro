-- ============================================================
-- Signo de las notas de crédito
--
-- BUG: había dos convenciones de signo para el mismo documento.
--   * anular_venta() genera la nota de crédito con montos NEGATIVOS.
--   * crear_venta() calculaba el total desde los ítems y lo dejaba POSITIVO.
--
-- Consecuencia (reproducida): una nota de crédito hecha a mano desde
-- Ventas → Nueva le SUMABA deuda al cliente en vez de restársela. Con una
-- factura de $108.900 y una NC de $54.450, la cuenta corriente mostraba
-- $163.350 de deuda en lugar de $54.450.
--
-- Afectaba a las tres vistas que suman ventas: Cuentas Corrientes, Reportes y
-- el Dashboard.
--
-- REGLA (la misma que usan lubricentro y MesaYa):
--   * NOTA_CREDITO  -> montos NEGATIVOS. Es una devolución: baja la deuda y
--     saca plata de la caja.
--   * NOTA_DEBITO   -> montos POSITIVOS. Es un cargo extra: sube la deuda.
--   * Todo lo demás  -> positivo.
--
-- A AFIP se le mandan siempre importes positivos (el carácter de crédito lo
-- da el CbteTipo 3/8/13), por eso el módulo fiscal ya toma valor absoluto.
-- ============================================================

-- Firma vieja (sin p_cbte_asoc_id): la sacamos para que no queden dos versiones.
DROP FUNCTION IF EXISTS public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz);

CREATE OR REPLACE FUNCTION public.crear_venta(
  p_sucursal_id      uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_items            jsonb,
  p_pagos            jsonb,
  p_percepciones     numeric DEFAULT 0,
  p_observaciones    text    DEFAULT NULL,
  p_nombre_obra      text    DEFAULT NULL,
  p_fecha            timestamptz DEFAULT NULL,
  -- Comprobante que rectifica una nota de crédito/débito. AFIP lo exige
  -- (CbtesAsoc): sin esto, la nota no se puede emitir.
  p_cbte_asoc_id     uuid    DEFAULT NULL
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid            uuid := auth.uid();
  v_is_admin       boolean;
  v_permite_neg    boolean;
  v_numero         text;
  v_venta_id       uuid;
  v_es_cta_cte     boolean;
  v_signo          integer;
  v_sub_sin_iva    numeric(14,2) := 0;
  v_iva_total      numeric(14,2) := 0;
  v_total          numeric(14,2);
  v_percepciones   numeric(14,2);
  v_total_pagado   numeric(14,2) := 0;
  v_estado_pago    public.estado_pago;
  it               jsonb;
  pg               jsonb;
  v_prod           public.productos%ROWTYPE;
  v_cant           numeric(14,2);
  v_desc           numeric(5,2);
  v_precio         numeric(14,2);
  v_precio_lista   numeric(14,2);
  v_sub_item       numeric(14,2);
  v_iva_item       numeric(14,2);
  v_stock_ant      numeric(14,2);
  v_stock_nue      numeric(14,2);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_is_admin := public.is_admin(v_uid);

  IF NOT v_is_admin AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés facturar en una sucursal que no es la tuya';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  SELECT COALESCE(permitir_stock_negativo, false) INTO v_permite_neg
    FROM public.settings WHERE id = true;
  v_permite_neg := COALESCE(v_permite_neg, false);

  -- Una nota de crédito RESTA. Una nota de débito SUMA.
  v_signo := CASE WHEN p_tipo_comprobante = 'NOTA_CREDITO' THEN -1 ELSE 1 END;

  -- Una nota tiene que rectificar un comprobante existente de ESTE cliente.
  IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
    IF p_cbte_asoc_id IS NULL THEN
      RAISE EXCEPTION 'Una nota de crédito/débito tiene que indicar el comprobante que rectifica';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.ventas
       WHERE id = p_cbte_asoc_id
         AND cliente_id = p_cliente_id
         AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
    ) THEN
      RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
    END IF;
  END IF;

  v_es_cta_cte := p_tipo_comprobante IN ('REMITO', 'REMITO_OBRA', 'FAC_INTERNA_CTA_CTE')
                  OR p_condicion_venta = 'CTA_CTE';

  ------------------------------------------------------------------
  -- Totales (precios resueltos contra el catálogo)
  ------------------------------------------------------------------
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente o inactivo', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    IF v_cant < 0 THEN
      RAISE EXCEPTION 'Cantidad negativa en el producto %', v_prod.codigo;
    END IF;

    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    IF v_precio < 0 THEN
      RAISE EXCEPTION 'Precio negativo en el producto %', v_prod.codigo;
    END IF;

    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2) * v_signo;
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    v_sub_sin_iva := v_sub_sin_iva + v_sub_item;
    v_iva_total   := v_iva_total   + v_iva_item;
  END LOOP;

  v_percepciones := ROUND(COALESCE(p_percepciones, 0), 2) * v_signo;
  v_total := ROUND(v_sub_sin_iva + v_iva_total + v_percepciones, 2);

  IF NOT v_es_cta_cte THEN
    SELECT COALESCE(SUM((p->>'monto')::numeric), 0) INTO v_total_pagado
      FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb)) p;
    -- El pago de una nota de crédito es plata que SALE de la caja.
    v_total_pagado := ROUND(ABS(v_total_pagado), 2) * v_signo;
  END IF;

  v_estado_pago := CASE
    WHEN v_es_cta_cte THEN 'PENDIENTE'::public.estado_pago
    -- Con signo negativo la comparación se invierte, así que trabajamos en valor
    -- absoluto: lo que importa es cuánto del comprobante quedó cubierto.
    WHEN ABS(v_total_pagado) >= ABS(v_total) - 0.01 THEN 'PAGADO'::public.estado_pago
    WHEN ABS(v_total_pagado) > 0 THEN 'PARCIAL'::public.estado_pago
    ELSE 'PENDIENTE'::public.estado_pago
  END;

  ------------------------------------------------------------------
  -- Cabecera
  ------------------------------------------------------------------
  v_numero := public.next_comprobante_numero(p_sucursal_id, p_tipo_comprobante);

  INSERT INTO public.ventas (
    sucursal_id, cliente_id, usuario_id, fecha, numero_comprobante, tipo_comprobante,
    condicion_venta, subtotal_sin_iva, iva_total, percepciones, total, total_pagado,
    estado_pago, observaciones, nombre_obra, afip_cbte_asoc_id
  ) VALUES (
    p_sucursal_id, p_cliente_id, v_uid, COALESCE(p_fecha, now()), v_numero, p_tipo_comprobante,
    CASE WHEN v_es_cta_cte THEN 'CTA_CTE'::public.condicion_venta ELSE p_condicion_venta END,
    v_sub_sin_iva, v_iva_total, v_percepciones, v_total, v_total_pagado,
    v_estado_pago, p_observaciones, p_nombre_obra, p_cbte_asoc_id
  ) RETURNING id INTO v_venta_id;

  ------------------------------------------------------------------
  -- Items + stock
  ------------------------------------------------------------------
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb))
  LOOP
    SELECT * INTO v_prod FROM public.productos WHERE id = (it->>'producto_id')::uuid;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);
    v_precio_lista := v_prod.precio_sin_iva;
    v_precio := COALESCE((it->>'precio_unitario_sin_iva')::numeric, v_precio_lista);
    v_sub_item := ROUND(v_precio * (1 - v_desc / 100) * v_cant, 2) * v_signo;
    v_iva_item := ROUND(v_sub_item * v_prod.iva_porcentaje / 100, 2);

    -- La cantidad queda positiva (es lo que se devuelve); lo que cambia de signo
    -- es la plata, para que la suma de los ítems coincida con la cabecera.
    INSERT INTO public.venta_items (
      venta_id, producto_id, codigo, descripcion, cantidad,
      precio_unitario_sin_iva, precio_lista_sin_iva, iva_porcentaje, descuento_porcentaje,
      subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_venta_id, v_prod.id, v_prod.codigo, v_prod.nombre, v_cant,
      v_precio, v_precio_lista, v_prod.iva_porcentaje, v_desc,
      v_sub_item, v_iva_item, v_sub_item + v_iva_item
    );

    CONTINUE WHEN p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') OR v_cant = 0;

    IF v_permite_neg THEN
      INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
      VALUES (v_prod.id, p_sucursal_id, -v_cant)
      ON CONFLICT (producto_id, sucursal_id)
      DO UPDATE SET cantidad = stock_sucursal.cantidad - v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;
    ELSE
      UPDATE public.stock_sucursal
         SET cantidad = cantidad - v_cant
       WHERE producto_id = v_prod.id
         AND sucursal_id = p_sucursal_id
         AND cantidad >= v_cant
      RETURNING cantidad + v_cant, cantidad INTO v_stock_ant, v_stock_nue;

      IF NOT FOUND THEN
        SELECT COALESCE(cantidad, 0) INTO v_stock_ant
          FROM public.stock_sucursal
         WHERE producto_id = v_prod.id AND sucursal_id = p_sucursal_id;
        RAISE EXCEPTION 'Stock insuficiente de % (%): hay %, se piden %',
          v_prod.nombre, v_prod.codigo, COALESCE(v_stock_ant, 0), v_cant;
      END IF;
    END IF;

    INSERT INTO public.stock_movimientos (
      producto_id, sucursal_id, tipo, cantidad, cantidad_anterior, cantidad_nueva,
      motivo, referencia_id, usuario_id
    ) VALUES (
      v_prod.id, p_sucursal_id, 'VENTA', -v_cant, v_stock_ant, v_stock_nue,
      p_tipo_comprobante::text || ' ' || v_numero, v_venta_id, v_uid
    );
  END LOOP;

  ------------------------------------------------------------------
  -- Pagos
  ------------------------------------------------------------------
  IF NOT v_es_cta_cte THEN
    FOR pg IN SELECT * FROM jsonb_array_elements(COALESCE(p_pagos, '[]'::jsonb))
    LOOP
      CONTINUE WHEN COALESCE((pg->>'monto')::numeric, 0) = 0;
      INSERT INTO public.venta_pagos (venta_id, forma_pago, monto, detalle)
      VALUES (
        v_venta_id,
        (pg->>'forma_pago')::public.forma_pago,
        -- Guardamos el pago YA CON SIGNO. Así la caja del día suma los pagos
        -- directamente y la devolución de una nota de crédito resta sola, sin
        -- que nadie tenga que acordarse de invertir el signo al leer.
        ROUND(ABS((pg->>'monto')::numeric), 2) * v_signo,
        COALESCE(pg->'detalle', '{}'::jsonb)
      );
    END LOOP;
  END IF;

  RETURN QUERY SELECT v_venta_id, v_numero, v_es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, jsonb, numeric, text, text, timestamptz, uuid) TO authenticated;
