-- ============================================================
-- PROVEEDOR EN PRODUCTOS + cambios de precio masivos transaccionales.
--
-- El pedido: "KUM cambió la lista de precios, ahora le tienen que aumentar un
-- 20%, a veces un 10%, entonces que se pueda seleccionar todos los productos de
-- este proveedor para aplicarle el markup que sea".
--
-- Hoy los productos no tienen proveedor, y el descuento comercial del 42% vive
-- en settings como si fuera de todos cuando en realidad es de Quimex.
--
-- Ver docs/superpowers/specs/2026-07-29-proveedor-en-productos-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. El proveedor del producto
-- ------------------------------------------------------------
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS proveedor_id uuid REFERENCES public.proveedores(id);
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON public.productos (proveedor_id);

COMMENT ON COLUMN public.productos.proveedor_id IS
  'Proveedor cuya LISTA DE PRECIOS gobierna el costo de este producto. NO es "los proveedores a los que se les puede comprar": para eso está producto_codigos_proveedor, que es una tabla de equivalencias de códigos y admite varios proveedores por producto.';

-- ------------------------------------------------------------
-- 2. El descuento comercial pasa a ser del proveedor
-- ------------------------------------------------------------
ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS descuento_porcentaje numeric(6,2);

DO $$ BEGIN
  ALTER TABLE public.proveedores
    ADD CONSTRAINT proveedores_descuento_valido
    CHECK (descuento_porcentaje IS NULL
           OR (descuento_porcentaje >= 0 AND descuento_porcentaje < 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.proveedores.descuento_porcentaje IS
  'Descuento comercial que este proveedor le hace al negocio sobre su precio de lista. NULL = usar settings.descuento_proveedor_porcentaje. 0 es un valor válido (comprar a precio de lista) y NO cae al global.';

-- El global quedó sin tope en 20260720100000. Como NULL en el proveedor significa
-- "usá el global", un 142 ahí vuelve a producir costos negativos y deja el
-- catálogo invendible (crear_venta rechaza precios negativos).
DO $$ BEGIN
  ALTER TABLE public.settings
    ADD CONSTRAINT settings_descuento_valido
    CHECK (descuento_proveedor_porcentaje >= 0 AND descuento_proveedor_porcentaje < 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cambiar el descuento comercial mueve el costo de TODO el catálogo de ese
-- proveedor. Hasta ahora la tabla la podía escribir cualquier autenticado y el
-- trigger sólo cuidaba la cuenta corriente y el criterio de códigos.
--
-- OJO al redefinir esta función: es la TERCERA versión. `CREATE OR REPLACE`
-- reemplaza el cuerpo entero, así que hay que arrastrar TODAS las protecciones
-- anteriores o se borran en silencio:
--   20260715100000  condicion_cta_cte
--   20260724100000  codigos_coinciden_con_los_propios
--   20260729110000  descuento_porcentaje              (esta)
CREATE OR REPLACE FUNCTION public.guard_proveedores_credito()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.condicion_cta_cte, false) IS TRUE THEN
      RAISE EXCEPTION 'Sólo un administrador puede habilitar cuenta corriente de proveedor';
    END IF;
    IF COALESCE(NEW.codigos_coinciden_con_los_propios, false) IS TRUE THEN
      RAISE EXCEPTION 'Sólo un administrador puede declarar que los códigos del proveedor son los propios';
    END IF;
    IF NEW.descuento_porcentaje IS NOT NULL THEN
      RAISE EXCEPTION 'Sólo un administrador puede fijar el descuento comercial del proveedor';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.condicion_cta_cte IS DISTINCT FROM OLD.condicion_cta_cte THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar la cuenta corriente del proveedor';
    END IF;
    IF NEW.codigos_coinciden_con_los_propios IS DISTINCT FROM OLD.codigos_coinciden_con_los_propios THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar el criterio de códigos del proveedor';
    END IF;
    IF NEW.descuento_porcentaje IS DISTINCT FROM OLD.descuento_porcentaje THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar el descuento comercial del proveedor';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

-- ------------------------------------------------------------
-- 3. Registro de operaciones masivas de precio
--
-- No hay historial de precios y no se pidió uno. Pero "aumentar 20%" NO es
-- idempotente: aplicarlo dos veces da +44% y no se deshace con un botón. Esta
-- tabla es la que hace que un doble click, un reintento o un F5 no repitan la
-- operación — y de paso deja registrado quién movió los precios y cuándo.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.precio_operaciones (
  idempotency_key uuid PRIMARY KEY,
  operacion       text NOT NULL CHECK (operacion IN ('MARKUP','AUMENTO','RECALCULAR_COSTO')),
  porcentaje      numeric(6,2) NOT NULL,
  productos       integer NOT NULL,
  usuario_id      uuid NOT NULL REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_precio_operaciones_fecha
  ON public.precio_operaciones (created_at DESC);

GRANT SELECT ON public.precio_operaciones TO authenticated;
GRANT ALL ON public.precio_operaciones TO service_role;
ALTER TABLE public.precio_operaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "precio_op select" ON public.precio_operaciones;
CREATE POLICY "precio_op select" ON public.precio_operaciones
  FOR SELECT TO authenticated USING (public.is_admin(auth.uid()));

-- ------------------------------------------------------------
-- 4. cambiar_precios_masivo
--
-- Toda la cadena de precios de src/lib/precios.ts, en SQL y en UNA transacción.
--
-- Por qué acá y no en el cliente: el camino viejo hacía un UPDATE por producto
-- desde el navegador. Con 1104 productos son minutos, y si se cortaba a la mitad
-- quedaba medio catálogo con precio nuevo y medio con el viejo, sin ninguna marca
-- de dónde se cortó. Para 'AUMENTO', que no es idempotente, eso es irreparable.
--
-- Operaciones:
--   MARKUP            fija markup_porcentaje = p_porcentaje.                 idempotente
--   AUMENTO           multiplica el precio de LISTA por (1+p/100) y RE-DERIVA
--                     el costo con el descuento del proveedor.           NO idempotente
--   RECALCULAR_COSTO  re-deriva el costo desde la lista con el descuento
--                     actual, sin tocar la lista.                            idempotente
--
-- REGLA de los precios a mano: las tres operaciones actualizan siempre los
-- precios que vienen del PROVEEDOR (lista, costo, sugerido), pero recalculan el
-- precio de VENTA sólo si el guardado coincide con la fórmula. Un precio puesto a
-- dedo es una decisión del negocio; se conserva y se informa aparte.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cambiar_precios_masivo(
  p_producto_ids    uuid[],
  p_operacion       text,
  p_porcentaje      numeric,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_previa       public.precio_operaciones%ROWTYPE;
  v_encontrados  integer;
  v_pedidos      integer := COALESCE(array_length(p_producto_ids, 1), 0);
  v_actualizados integer := 0;
  v_manual       integer := 0;
  v_sin_base     integer := 0;
  v_sin_cambio   integer := 0;
  v_factor       numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar precios de forma masiva';
  END IF;
  IF p_operacion NOT IN ('MARKUP','AUMENTO','RECALCULAR_COSTO') THEN
    RAISE EXCEPTION 'Operación desconocida: %', p_operacion;
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Falta la clave de idempotencia';
  END IF;
  IF v_pedidos = 0 THEN
    RAISE EXCEPTION 'No se seleccionó ningún producto';
  END IF;
  -- Un markup o un aumento negativo es casi siempre un tipeo. -100% sería regalar.
  IF p_porcentaje IS NULL OR p_porcentaje < 0 OR p_porcentaje > 1000 THEN
    RAISE EXCEPTION 'Porcentaje fuera de rango: %', p_porcentaje;
  END IF;

  -- Serializa los llamados con la MISMA clave. Sin esto, dos clicks simultáneos
  -- pasaban los dos el SELECT de abajo y el perdedor moría con el error crudo del
  -- índice único ("duplicate key value violates...") por una operación que SÍ se
  -- había aplicado. Los datos aguantaban (rollback completo), pero el cartel era
  -- incomprensible. Mismo recurso que ajustar_stock_masivo.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  -- Reintento / doble click / F5: la misma operación no se aplica dos veces.
  SELECT * INTO v_previa FROM public.precio_operaciones
   WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    -- La clave identifica UNA operación concreta. Si vuelve con otra operación o
    -- con otro porcentaje, no es un reintento: es una operación distinta que se
    -- perdería en silencio (el cliente creería que se aplicó y no se aplicó nada).
    IF v_previa.operacion IS DISTINCT FROM p_operacion
       OR v_previa.porcentaje IS DISTINCT FROM p_porcentaje
       OR v_previa.productos IS DISTINCT FROM v_pedidos THEN
      RAISE EXCEPTION 'Esa clave ya se usó para otra operación (% al %, sobre % productos). Cerrá y volvé a abrir el diálogo.',
        v_previa.operacion, v_previa.porcentaje, v_previa.productos;
    END IF;
    RETURN jsonb_build_object(
      'ya_aplicado', true, 'actualizados', 0, 'precio_manual', 0, 'sin_base', 0,
      'productos', v_previa.productos);
  END IF;

  v_factor := 1 + p_porcentaje / 100.0;

  -- ANTI-DEADLOCK. Bloquear las filas por id (o en orden de scan) NO alcanza:
  -- crear_venta recorre sus ítems en el orden del payload, no por producto_id. Una
  -- operación masiva que toma A y espera B, contra una venta que tomó B y espera
  -- A, es un ciclo — y Postgres mata a una de las dos. Reproducido: la que moría
  -- era LA VENTA, con "deadlock detected", en pleno horario de mostrador.
  --
  -- Un único lock de tabla al principio, sin tener nada tomado, hace imposible el
  -- ciclo: el SHARE ROW EXCLUSIVE choca con el ROW EXCLUSIVE de los INSERT/UPDATE
  -- de las demás RPC, así que la venta ESPERA en vez de morir. Es el mismo recurso
  -- que ajustar_stock_masivo (ver §5.3 de 2026-07-24-conteo-fisico-design.md).
  -- El costo es frenar las ventas mientras corre: 1500 productos tardan ~40 ms.
  LOCK TABLE public.productos IN SHARE ROW EXCLUSIVE MODE;

  CREATE TEMP TABLE _objetivo ON COMMIT DROP AS
  SELECT p.id,
         p.precio_lista,
         p.precio_fabrica,
         p.precio_sugerido_publico,
         p.precio_sin_iva,
         p.iva_porcentaje,
         p.markup_porcentaje AS markup_crudo,
         COALESCE(p.markup_porcentaje, s.markup_default_porcentaje, 30) AS markup,
         COALESCE(prov.descuento_porcentaje, s.descuento_proveedor_porcentaje, 42) AS descuento
    FROM public.productos p
    CROSS JOIN LATERAL (SELECT * FROM public.settings LIMIT 1) s
    LEFT JOIN public.proveedores prov ON prov.id = p.proveedor_id
   WHERE p.id = ANY(p_producto_ids);

  SELECT count(*) INTO v_encontrados FROM _objetivo;
  IF v_encontrados <> v_pedidos THEN
    RAISE EXCEPTION 'Se seleccionaron % productos pero se encontraron %. No se aplicó nada.',
      v_pedidos, v_encontrados;
  END IF;

  -- Un solo UPDATE. Cada columna decide su valor nuevo según la operación, y el
  -- precio de venta se recalcula sólo si el guardado coincidía con la fórmula
  -- vieja (o sea: si no estaba puesto a mano).
  WITH calc AS (
    SELECT o.id,
           o.markup, o.descuento, o.iva_porcentaje AS iva,
           -- ¿el precio guardado lo explica la fórmula, con los valores VIEJOS?
           (CASE
              WHEN o.precio_sugerido_publico > 0 THEN
                abs(o.precio_sin_iva
                    - round(o.precio_sugerido_publico * (1 + o.markup/100.0)
                            / (1 + o.iva_porcentaje/100.0), 2)) <= 0.01
              WHEN o.precio_fabrica > 0 THEN
                abs(o.precio_sin_iva - round(o.precio_fabrica * (1 + o.markup/100.0), 2)) <= 0.01
              ELSE false
            END) AS derivado,
           -- ¿tiene alguna base sobre la que operar?
           (o.precio_lista > 0 OR o.precio_fabrica > 0
            OR COALESCE(o.precio_sugerido_publico, 0) > 0) AS con_base,
           -- lista nueva
           (CASE WHEN p_operacion = 'AUMENTO' AND o.precio_lista > 0
                 THEN round(o.precio_lista * v_factor, 2)
                 ELSE o.precio_lista END) AS lista_new,
           -- sugerido nuevo
           (CASE WHEN p_operacion = 'AUMENTO' AND o.precio_sugerido_publico > 0
                 THEN round(o.precio_sugerido_publico * v_factor, 2)
                 ELSE o.precio_sugerido_publico END) AS sug_new,
           -- markup nuevo
           (CASE WHEN p_operacion = 'MARKUP' THEN p_porcentaje ELSE o.markup END) AS mk_new,
           o.precio_lista, o.precio_fabrica, o.precio_sin_iva
      FROM _objetivo o
  ), calc2 AS (
    SELECT c.*,
           -- costo nuevo: si hay lista, se RE-DERIVA con el descuento (nunca se
           -- multiplica el costo guardado, que puede venir de un descuento
           -- equivocado o de una edición a mano). Si no hay lista, la única base
           -- es el costo, así que ahí sí se multiplica.
           (CASE
              WHEN p_operacion IN ('AUMENTO','RECALCULAR_COSTO') AND c.lista_new > 0
                THEN round(c.lista_new * (1 - c.descuento/100.0), 2)
              WHEN p_operacion = 'AUMENTO' AND c.precio_lista = 0 AND c.precio_fabrica > 0
                THEN round(c.precio_fabrica * v_factor, 2)
              ELSE c.precio_fabrica
            END) AS costo_new
      FROM calc c
  ), final AS (
    SELECT c.*,
           (CASE
              WHEN c.sug_new > 0
                THEN round(c.sug_new * (1 + c.mk_new/100.0) / (1 + c.iva/100.0), 2)
              ELSE round(c.costo_new * (1 + c.mk_new/100.0), 2)
            END) AS venta_new
      FROM calc2 c
  )
  UPDATE public.productos p
     SET precio_lista            = f.lista_new,
         precio_fabrica          = f.costo_new,
         precio_sugerido_publico = f.sug_new,
         markup_porcentaje       = CASE WHEN p_operacion = 'MARKUP'
                                        THEN p_porcentaje ELSE p.markup_porcentaje END,
         -- Sólo se toca la venta si estaba derivada y el resultado es > 0. Un
         -- precio a mano se conserva; vender a $0 no es una opción.
         precio_sin_iva          = CASE WHEN f.derivado AND f.venta_new > 0
                                        THEN f.venta_new ELSE p.precio_sin_iva END
    FROM final f
   -- MARKUP guarda el % en TODOS los seleccionados, tengan base o no: cuando
   -- después se les cargue el costo, el precio sale solo con ese markup. Es lo que
   -- hacía el camino viejo y lo que informa el cartel. Para AUMENTO y
   -- RECALCULAR_COSTO sí se saltean los que no tienen base: multiplicar cero da
   -- cero.
   WHERE p.id = f.id AND (f.con_base OR p_operacion = 'MARKUP');

  -- Los contadores se leen comparando lo que QUEDÓ contra el estado previo que
  -- guardó _objetivo, no recalculando las condiciones. Antes se calculaban aparte
  -- y decían "recalculado" sobre productos donde nada había cambiado: para
  -- RECALCULAR_COSTO, un producto con costo pero sin precio de lista tiene base y
  -- aun así no se toca. Un cambio de precios que informa de más es tan malo como
  -- uno que informa de menos.
  --
  -- Las cuatro categorías son excluyentes y suman el total:
  --   actualizados   cambió algo Y se recalculó el precio de venta
  --   precio_manual  cambió el costo, pero la venta estaba puesta a mano y quedó
  --   sin_cambio     tenía base pero esta operación no le tocaba nada
  --   sin_base       no tiene ni lista, ni costo, ni sugerido
  SELECT
    count(*) FILTER (WHERE con_base AND cambio AND cambio_venta),
    count(*) FILTER (WHERE con_base AND cambio AND NOT cambio_venta),
    count(*) FILTER (WHERE con_base AND NOT cambio),
    count(*) FILTER (WHERE NOT con_base)
    INTO v_actualizados, v_manual, v_sin_cambio, v_sin_base
  FROM (
    SELECT (t.precio_lista > 0 OR t.precio_fabrica > 0
            OR COALESCE(t.precio_sugerido_publico, 0) > 0) AS con_base,
           (p.precio_lista            IS DISTINCT FROM t.precio_lista
         OR p.precio_fabrica          IS DISTINCT FROM t.precio_fabrica
         OR p.precio_sugerido_publico IS DISTINCT FROM t.precio_sugerido_publico
         OR p.precio_sin_iva          IS DISTINCT FROM t.precio_sin_iva
         OR p.markup_porcentaje       IS DISTINCT FROM t.markup_crudo) AS cambio,
           (p.precio_sin_iva IS DISTINCT FROM t.precio_sin_iva) AS cambio_venta
      FROM _objetivo t
      JOIN public.productos p ON p.id = t.id
  ) o;

  INSERT INTO public.precio_operaciones
    (idempotency_key, operacion, porcentaje, productos, usuario_id)
  VALUES (p_idempotency_key, p_operacion, p_porcentaje, v_pedidos, v_uid);

  RETURN jsonb_build_object(
    'ya_aplicado', false,
    'actualizados', v_actualizados,
    'precio_manual', v_manual,
    'sin_base', v_sin_base,
    'sin_cambio', v_sin_cambio,
    'productos', v_pedidos);
END; $$;

REVOKE ALL ON FUNCTION public.cambiar_precios_masivo(uuid[], text, numeric, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.cambiar_precios_masivo(uuid[], text, numeric, uuid) TO authenticated;
