-- ============================================================
-- PRESUPUESTOS — un papel con precios, que no compromete nada.
--
-- "Tienen que poder hacer presupuestos que lógicamente esos productos no se van
-- del stock y ese monto tampoco se cobra, porque es un presupuesto para mandarle
-- a cualquier cliente. Pero después, si ese cliente viene, tienen que poder
-- asociar el presupuesto y se les cargan todos los productos que habían puesto
-- con el precio que les habían hecho."
--
-- No descuenta stock, no entra a la caja, no genera deuda, no va a AFIP y no
-- suma en los reportes de ventas. Lo único que hace es CONGELAR PRECIOS para
-- cuando el cliente vuelva.
--
-- Ver docs/superpowers/specs/2026-07-29-presupuestos-design.md
-- ============================================================

CREATE TABLE IF NOT EXISTS public.presupuestos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id      uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id       uuid NOT NULL REFERENCES auth.users(id),
  numero           text NOT NULL UNIQUE,
  fecha            timestamptz NOT NULL DEFAULT now(),
  validez_hasta    date,
  -- Un presupuesto se hace "para cualquier cliente": puede no haber ninguno
  -- cargado todavía. Por eso cliente_id es opcional y hay un nombre suelto.
  cliente_id       uuid REFERENCES public.clientes(id),
  nombre_cliente   text,
  subtotal_sin_iva numeric(14,2) NOT NULL DEFAULT 0,
  iva_total        numeric(14,2) NOT NULL DEFAULT 0,
  total            numeric(14,2) NOT NULL DEFAULT 0,
  estado           text NOT NULL DEFAULT 'ABIERTO'
                     CHECK (estado IN ('ABIERTO','CONVERTIDO','ANULADO')),
  venta_id         uuid REFERENCES public.ventas(id),
  observaciones    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Hace imposible el estado incoherente "convertido pero no se sabe en qué
  -- venta", que es justo el que después nadie puede explicar.
  CONSTRAINT presupuesto_convertido_tiene_venta
    CHECK ((estado = 'CONVERTIDO') = (venta_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_presupuestos_fecha ON public.presupuestos (fecha DESC);
CREATE INDEX IF NOT EXISTS idx_presupuestos_cliente ON public.presupuestos (cliente_id);

CREATE TABLE IF NOT EXISTS public.presupuesto_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presupuesto_id       uuid NOT NULL REFERENCES public.presupuestos(id) ON DELETE CASCADE,
  producto_id          uuid NOT NULL REFERENCES public.productos(id),
  -- Snapshot: el presupuesto tiene que poder reimprimirse igual dentro de un mes,
  -- aunque al producto le hayan cambiado el nombre o lo hayan archivado.
  codigo               text NOT NULL,
  descripcion          text NOT NULL,
  cantidad             numeric(14,2) NOT NULL CHECK (cantidad > 0),
  -- El precio de catálogo y el descuento van POR SEPARADO: el presupuesto tiene
  -- que poder decir "te hago 10% sobre $1.000", no sólo "$900".
  precio_lista_sin_iva numeric(14,2) NOT NULL CHECK (precio_lista_sin_iva >= 0),
  descuento_porcentaje numeric(5,2)  NOT NULL DEFAULT 0
                         CHECK (descuento_porcentaje >= 0 AND descuento_porcentaje <= 100),
  precio_sin_iva       numeric(14,2) NOT NULL CHECK (precio_sin_iva >= 0),
  iva_porcentaje       numeric(5,2)  NOT NULL,
  subtotal_sin_iva     numeric(14,2) NOT NULL,
  iva_monto            numeric(14,2) NOT NULL,
  subtotal_con_iva     numeric(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presupuesto_items_pres ON public.presupuesto_items (presupuesto_id);

-- RLS igual que ventas: admin ve todo, empleado ve su sucursal. La escritura la
-- hacen sólo las RPC.
GRANT SELECT ON public.presupuestos, public.presupuesto_items TO authenticated;
GRANT ALL ON public.presupuestos, public.presupuesto_items TO service_role;
ALTER TABLE public.presupuestos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.presupuesto_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "presup select" ON public.presupuestos;
CREATE POLICY "presup select" ON public.presupuestos FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());
DROP POLICY IF EXISTS "presup items select" ON public.presupuesto_items;
CREATE POLICY "presup items select" ON public.presupuesto_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.presupuestos p
                  WHERE p.id = presupuesto_id
                    AND (public.is_admin(auth.uid()) OR p.sucursal_id = public.current_sucursal_id())));
DROP TRIGGER IF EXISTS trg_presupuestos_upd ON public.presupuestos;
CREATE TRIGGER trg_presupuestos_upd BEFORE UPDATE ON public.presupuestos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- crear_presupuesto
--
-- Los PRECIOS los pone el servidor, leyéndolos de `productos`, igual que
-- crear_venta: el precio unitario no puede venir del navegador. Eso ya fue un
-- agujero en este sistema (20260713120000_seguridad_y_venta_atomica.sql:12).
-- Lo que sí viene de afuera es el DESCUENTO, acotado a [0,100] — hacer un precio
-- es la razón de ser de un presupuesto.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crear_presupuesto(
  p_sucursal_id    uuid,
  p_items          jsonb,
  p_cliente_id     uuid DEFAULT NULL,
  p_nombre_cliente text DEFAULT NULL,
  p_validez_hasta  date DEFAULT NULL,
  p_observaciones  text DEFAULT NULL
)
RETURNS TABLE (presupuesto_id uuid, numero text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_id     uuid;
  v_numero text;
  v_sub    numeric(14,2) := 0;
  v_iva    numeric(14,2) := 0;
  it       jsonb;
  v_prod   public.productos%ROWTYPE;
  v_cant   numeric(14,2);
  v_desc   numeric(5,2);
  v_precio numeric(14,2);
  v_si     numeric(14,2);
  v_ii     numeric(14,2);
  v_calc   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  IF NOT public.is_admin(v_uid) AND p_sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés hacer un presupuesto en una sucursal que no es la tuya';
  END IF;
  IF COALESCE(jsonb_array_length(p_items), 0) = 0 THEN
    RAISE EXCEPTION 'El presupuesto necesita al menos un producto';
  END IF;
  IF p_cliente_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    SELECT * INTO v_prod FROM public.productos
      WHERE id = (it->>'producto_id')::uuid AND activo AND NOT archivado;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Producto % inexistente, inactivo o archivado', it->>'producto_id';
    END IF;

    v_cant := COALESCE((it->>'cantidad')::numeric, 0);
    IF v_cant <= 0 THEN
      RAISE EXCEPTION 'Cantidad inválida en el producto %', v_prod.codigo;
    END IF;
    v_desc := LEAST(GREATEST(COALESCE((it->>'descuento_porcentaje')::numeric, 0), 0), 100);

    -- El precio sale del catálogo, NO del payload.
    v_precio := ROUND(v_prod.precio_sin_iva * (1 - v_desc / 100), 2);
    v_si := ROUND(v_precio * v_cant, 2);
    v_ii := ROUND(v_si * v_prod.iva_porcentaje / 100, 2);
    v_sub := v_sub + v_si;
    v_iva := v_iva + v_ii;

    v_calc := v_calc || jsonb_build_object(
      'producto_id', v_prod.id, 'codigo', v_prod.codigo, 'descripcion', v_prod.nombre,
      'cantidad', v_cant, 'lista', v_prod.precio_sin_iva, 'descuento', v_desc,
      'precio', v_precio, 'iva_pct', v_prod.iva_porcentaje, 'si', v_si, 'ii', v_ii);
  END LOOP;

  v_numero := public.next_documento_numero(p_sucursal_id, 'PRESUPUESTO', 'PRES');

  INSERT INTO public.presupuestos (
    sucursal_id, usuario_id, numero, validez_hasta, cliente_id, nombre_cliente,
    subtotal_sin_iva, iva_total, total, observaciones
  ) VALUES (
    p_sucursal_id, v_uid, v_numero, p_validez_hasta, p_cliente_id, p_nombre_cliente,
    v_sub, v_iva, ROUND(v_sub + v_iva, 2), p_observaciones
  ) RETURNING id INTO v_id;

  FOR it IN SELECT * FROM jsonb_array_elements(v_calc)
  LOOP
    INSERT INTO public.presupuesto_items (
      presupuesto_id, producto_id, codigo, descripcion, cantidad,
      precio_lista_sin_iva, descuento_porcentaje, precio_sin_iva,
      iva_porcentaje, subtotal_sin_iva, iva_monto, subtotal_con_iva
    ) VALUES (
      v_id, (it->>'producto_id')::uuid, it->>'codigo', it->>'descripcion',
      (it->>'cantidad')::numeric, (it->>'lista')::numeric, (it->>'descuento')::numeric,
      (it->>'precio')::numeric, (it->>'iva_pct')::numeric,
      (it->>'si')::numeric, (it->>'ii')::numeric,
      ROUND((it->>'si')::numeric + (it->>'ii')::numeric, 2));
  END LOOP;

  RETURN QUERY SELECT v_id, v_numero;
END; $$;

REVOKE ALL ON FUNCTION public.crear_presupuesto(uuid, jsonb, uuid, text, date, text) FROM public;
GRANT EXECUTE ON FUNCTION public.crear_presupuesto(uuid, jsonb, uuid, text, date, text) TO authenticated;

-- ------------------------------------------------------------
-- convertir_presupuesto_en_venta
--
-- El corazón de la feature, y NO toca crear_venta.
--
-- `crear_venta` ya acepta `precio_unitario_sin_iva` por ítem. Los precios que se
-- le pasan salen de `presupuesto_items` —una tabla que sólo escriben las RPC—,
-- así que el precio no viene del navegador y la propiedad de seguridad se
-- mantiene sin agregar parámetros ni extraer nada del corazón transaccional
-- (idempotencia, stock, caja, límite de crédito, numeración, AFIP).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convertir_presupuesto_en_venta(
  p_presupuesto_id   uuid,
  p_cliente_id       uuid,
  p_tipo_comprobante public.tipo_comprobante,
  p_condicion_venta  public.condicion_venta,
  p_pagos            jsonb DEFAULT '[]'::jsonb,
  p_idempotency_key  uuid  DEFAULT NULL
)
RETURNS TABLE (venta_id uuid, numero text, es_cta_cte boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_p     public.presupuestos%ROWTYPE;
  v_items jsonb;
  v_res   record;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;

  -- Un presupuesto se convierte UNA sola vez. El lock evita que dos personas lo
  -- conviertan a la vez y salgan dos ventas por la misma mercadería.
  SELECT * INTO v_p FROM public.presupuestos WHERE id = p_presupuesto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Presupuesto no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés convertir un presupuesto de otra sucursal';
  END IF;
  IF v_p.estado <> 'ABIERTO' THEN
    RAISE EXCEPTION 'Este presupuesto ya está %', lower(v_p.estado);
  END IF;

  -- El cliente se valida ACÁ, no sólo en la pantalla: ventas.cliente_id es NOT
  -- NULL y una conversión sin cliente dejaría el presupuesto marcado como
  -- convertido sin venta.
  IF p_cliente_id IS NULL THEN
    RAISE EXCEPTION 'Para convertir un presupuesto hay que elegir el cliente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clientes WHERE id = p_cliente_id AND activo) THEN
    RAISE EXCEPTION 'Cliente inexistente o inactivo';
  END IF;

  -- Los ítems, CON LOS PRECIOS DEL PRESUPUESTO. Ordenados por producto_id: dos
  -- conversiones concurrentes que comparten productos piden los locks en el mismo
  -- orden, así que entre ellas no puede haber ciclo.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'producto_id'), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
               'producto_id', i.producto_id,
               'cantidad', i.cantidad,
               -- El precio YA tiene el descuento aplicado (crear_presupuesto lo
               -- calculó así), por eso el descuento no se manda de nuevo: se
               -- aplicaría dos veces.
               'precio_unitario_sin_iva', i.precio_sin_iva
             ) AS x
        FROM public.presupuesto_items i
       WHERE i.presupuesto_id = p_presupuesto_id
    ) t;

  IF jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'El presupuesto no tiene productos';
  END IF;

  SELECT * INTO v_res FROM public.crear_venta(
    v_p.sucursal_id, p_cliente_id, p_tipo_comprobante, p_condicion_venta,
    v_items, COALESCE(p_pagos, '[]'::jsonb), 0,
    'Presupuesto ' || v_p.numero, NULL, NULL, NULL, p_idempotency_key);

  UPDATE public.presupuestos
     SET estado = 'CONVERTIDO', venta_id = v_res.venta_id, cliente_id = p_cliente_id
   WHERE id = p_presupuesto_id;

  RETURN QUERY SELECT v_res.venta_id, v_res.numero, v_res.es_cta_cte;
END; $$;

REVOKE ALL ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.convertir_presupuesto_en_venta(uuid, uuid, public.tipo_comprobante, public.condicion_venta, jsonb, uuid) TO authenticated;

-- ------------------------------------------------------------
-- anular_presupuesto
--
-- Sólo si está ABIERTO. Un presupuesto convertido no se anula: se anula la
-- venta, que tiene su propio circuito con nota de crédito.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.anular_presupuesto(p_presupuesto_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_p   public.presupuestos%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'No autenticado'; END IF;
  SELECT * INTO v_p FROM public.presupuestos WHERE id = p_presupuesto_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Presupuesto no encontrado'; END IF;
  IF NOT public.is_admin(v_uid) AND v_p.sucursal_id IS DISTINCT FROM public.current_sucursal_id() THEN
    RAISE EXCEPTION 'No podés anular un presupuesto de otra sucursal';
  END IF;
  IF v_p.estado = 'CONVERTIDO' THEN
    RAISE EXCEPTION 'Este presupuesto ya se convirtió en la venta. Para deshacerlo, anulá la venta.';
  END IF;
  IF v_p.estado = 'ANULADO' THEN RETURN; END IF;
  UPDATE public.presupuestos SET estado = 'ANULADO' WHERE id = p_presupuesto_id;
END; $$;

REVOKE ALL ON FUNCTION public.anular_presupuesto(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.anular_presupuesto(uuid) TO authenticated;
