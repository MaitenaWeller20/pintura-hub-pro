-- ============================================================
-- INGRESOS DE MERCADERÍA (remito del proveedor) — esquema
--
-- Circuito para cargar mercadería a partir del PDF/foto del remito que manda el
-- proveedor. El remito NO trae precios: este circuito mueve SOLO STOCK. No toca
-- caja ni cuenta corriente — la deuda sigue viviendo en /compras.
--
-- OJO con el nombre: en este sistema "remito" (tabla remitos, ruta /remitos) es la
-- TRANSFERENCIA ENTRE SUCURSALES, y REMITO es además un comprobante de venta. Esto
-- es otra cosa y por eso se llama "ingreso de mercadería". La palabra remito sólo
-- aparece en numero_remito_proveedor, que es el número del papel del proveedor.
--
-- Estas tablas NO llevan caja_sesion_id ni el trigger estampar_caja_sesion: no hay
-- plata en juego y ese trigger auto-abre caja cuando encuentra la columna en NULL.
--
-- Escritura cerrada: sólo las RPC SECURITY DEFINER de la migración siguiente.
-- Ver docs/superpowers/specs/2026-07-24-ingresos-mercaderia-design.md
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------
-- 1. ENUM: entrada/salida de mercadería por remito de proveedor
-- ------------------------------------------------------------
ALTER TYPE public.tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'INGRESO_MERCADERIA';
ALTER TYPE public.tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'ANULACION_INGRESO_MERCADERIA';

-- ------------------------------------------------------------
-- 2. NORMALIZACIÓN de números de remito y códigos de proveedor
--
-- El número viene del OCR del MISMO PDF impreso, que siempre lee la misma cadena
-- ("00054-00023918"). Basta con neutralizar diferencias de formato triviales:
-- mayúsculas, sin acentos, sin separadores/espacios. Los ceros se DEJAN: quitarlos
-- de la cadena ya concatenada rompería los límites de segmento (el "00023918" de
-- "00054-00023918" no es un cero a la izquierda) y no aporta nada al caso real —
-- el mismo remito leído dos veces produce la misma cadena de todos modos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalizar_codigo(p_texto text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    regexp_replace(
      upper(translate(COALESCE(p_texto, ''), 'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNAEIOUUN')),
      '[^A-Z0-9]', '', 'g'
    ),
    ''
  );
$$;

COMMENT ON FUNCTION public.normalizar_codigo(text) IS
  'Canonicaliza números de remito y códigos de proveedor (mayúsculas, sin acentos ni separadores) para comparar y para los índices únicos.';

-- ------------------------------------------------------------
-- 3. PROVEEDORES: ¿sus códigos son los míos?
--
-- Quimexur usa los mismos códigos que CasaForma, así que su remito se puede
-- matchear por código exacto. KUM no: sus códigos son numéricos cortos (86013,
-- 26301) y si alguno coincidiera por casualidad con un código interno, un match
-- automático global metería la mercadería en el producto equivocado EN SILENCIO.
-- Por eso el match por código va detrás de este flag, y lo prende sólo un admin.
-- ------------------------------------------------------------
ALTER TABLE public.proveedores
  ADD COLUMN IF NOT EXISTS codigos_coinciden_con_los_propios boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.proveedores.codigos_coinciden_con_los_propios IS
  'true = los códigos que este proveedor pone en su remito son los mismos códigos de productos.codigo, y se puede matchear por código exacto al ingresar mercadería.';

-- Se suma al guard que ya existe para condicion_cta_cte (mismo criterio: las
-- condiciones que cambian cómo se procesa la plata o el stock las toca un admin).
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
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.condicion_cta_cte IS DISTINCT FROM OLD.condicion_cta_cte THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar la cuenta corriente del proveedor';
    END IF;
    IF NEW.codigos_coinciden_con_los_propios IS DISTINCT FROM OLD.codigos_coinciden_con_los_propios THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar el criterio de códigos del proveedor';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

-- ------------------------------------------------------------
-- 4. PRODUCTO_CODIGOS_PROVEEDOR — la tabla que aprende
--
-- La primera vez que la usuaria mapea "86013 Masilla Plastica 500grs Zeocar" a su
-- producto, queda acá. El segundo remito de KUM ya viene resuelto solo y sin pagar
-- IA de matching. Es la pieza que le saca el trabajo repetitivo de encima.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.producto_codigos_proveedor (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id          uuid NOT NULL REFERENCES public.proveedores(id) ON DELETE CASCADE,
  codigo_proveedor      text NOT NULL,
  -- Normalizado (mayúsculas, sin espacios ni separadores): la unicidad y el match
  -- van por acá, para que "86013", "86 013" y "86013 " sean la MISMA equivalencia.
  codigo_proveedor_norm text GENERATED ALWAYS AS (public.normalizar_codigo(codigo_proveedor)) STORED,
  producto_id           uuid NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
  descripcion_proveedor text,
  usuario_id            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT codigo_proveedor_no_vacio CHECK (public.normalizar_codigo(codigo_proveedor) IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prod_cod_prov
  ON public.producto_codigos_proveedor (proveedor_id, codigo_proveedor_norm);
CREATE INDEX IF NOT EXISTS idx_prod_cod_prov_norm
  ON public.producto_codigos_proveedor (proveedor_id, codigo_proveedor_norm);
CREATE INDEX IF NOT EXISTS idx_prod_cod_prov_producto
  ON public.producto_codigos_proveedor (producto_id);

GRANT SELECT ON public.producto_codigos_proveedor TO authenticated;
GRANT ALL ON public.producto_codigos_proveedor TO service_role;
ALTER TABLE public.producto_codigos_proveedor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prod_cod_prov select" ON public.producto_codigos_proveedor;
CREATE POLICY "prod_cod_prov select" ON public.producto_codigos_proveedor
  FOR SELECT TO authenticated USING (true);
DROP TRIGGER IF EXISTS trg_prod_cod_prov_upd ON public.producto_codigos_proveedor;
CREATE TRIGGER trg_prod_cod_prov_upd BEFORE UPDATE ON public.producto_codigos_proveedor
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 5. INGRESOS_MERCADERIA (cabecera)
--
-- El borrador se crea ANTES de llamar al modelo, así una extracción que falla
-- queda visible en estado ERROR en vez de evaporarse. El stock se mueve sólo en la
-- transición BORRADOR -> CONFIRMADO.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingresos_mercaderia (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id            uuid NOT NULL REFERENCES public.proveedores(id),
  sucursal_id             uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id              uuid NOT NULL REFERENCES auth.users(id),
  numero_remito_proveedor text,
  numero_normalizado      text,
  fecha_remito            date,
  fecha_carga             timestamptz NOT NULL DEFAULT now(),
  fecha_confirmacion      timestamptz,
  estado                  text NOT NULL DEFAULT 'BORRADOR'
    CHECK (estado IN ('BORRADOR', 'CONFIRMADO', 'ANULADO')),
  extraccion_estado       text NOT NULL DEFAULT 'PENDIENTE'
    CHECK (extraccion_estado IN ('PENDIENTE', 'OK', 'ERROR')),
  extraccion_error        text,
  archivo_path            text,
  extraccion              jsonb,
  uso_tokens              jsonb,
  idempotency_key         uuid,
  -- Si el documento trae dos remitos/fechas mezclados, la extracción deja acá el
  -- mensaje y la confirmación se bloquea. Se persiste (no vive sólo en React) para
  -- que el bloqueo sobreviva al refresh, al retomar borrador y a una llamada directa.
  bloqueo_confirmacion    text,
  observaciones           text,
  motivo_anulacion        text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- El mismo papel no entra dos veces. Global por proveedor (no por sucursal): un
-- remito es un documento único del proveedor, no algo que se repita por sucursal.
-- Los borradores no bloquean; si no se pudo leer el número, tampoco.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingresos_remito_confirmado
  ON public.ingresos_mercaderia (proveedor_id, numero_normalizado)
  WHERE estado = 'CONFIRMADO' AND numero_normalizado IS NOT NULL;

-- Idempotencia dura del confirmar: mismo patrón que ventas
-- (20260718121000_g4_validaciones_crear_venta.sql).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingresos_idempotency_key
  ON public.ingresos_mercaderia (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ingresos_sucursal_fecha
  ON public.ingresos_mercaderia (sucursal_id, fecha_carga DESC);
CREATE INDEX IF NOT EXISTS idx_ingresos_proveedor
  ON public.ingresos_mercaderia (proveedor_id, fecha_carga DESC);
-- Soporta el rate limit de extracciones por usuario/hora.
CREATE INDEX IF NOT EXISTS idx_ingresos_usuario_fecha
  ON public.ingresos_mercaderia (usuario_id, created_at DESC);

GRANT SELECT ON public.ingresos_mercaderia TO authenticated;
GRANT ALL ON public.ingresos_mercaderia TO service_role;
ALTER TABLE public.ingresos_mercaderia ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ingresos select" ON public.ingresos_mercaderia;
CREATE POLICY "ingresos select" ON public.ingresos_mercaderia FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());
DROP TRIGGER IF EXISTS trg_ingresos_upd ON public.ingresos_mercaderia;
CREATE TRIGGER trg_ingresos_upd BEFORE UPDATE ON public.ingresos_mercaderia
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 6. INGRESO_MERCADERIA_ITEMS
--
-- Los campos _raw y pagina guardan lo que decía el papel TEXTUALMENTE. Son la
-- defensa contra el problema clásico de estos remitos: en el de Quimexur,
-- "BASE TINT. ACRIL. EXT. TINTE | 10 | LT. | 1.00" tiene el envase (10 LT) en el
-- medio y la cantidad real (1.00) al final. Guardando el crudo se puede auditar
-- una carga dudosa contra el papel sin volver a leer el PDF.
--
-- producto_id es NULL mientras el ingreso está en BORRADOR; al confirmar, toda
-- línea no ignorada tiene que tenerlo (lo valida la RPC).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingreso_mercaderia_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingreso_id            uuid NOT NULL REFERENCES public.ingresos_mercaderia(id) ON DELETE CASCADE,
  linea                 integer NOT NULL,
  producto_id           uuid REFERENCES public.productos(id),
  codigo                text,
  descripcion           text,
  cantidad              numeric(14,2),
  codigo_proveedor      text,
  descripcion_proveedor text,
  cantidad_raw          text,
  descripcion_raw       text,
  pagina                integer,
  origen_match          text NOT NULL DEFAULT 'MANUAL'
    CHECK (origen_match IN ('APRENDIDO', 'CODIGO', 'IA', 'MANUAL', 'NUEVO', 'IGNORADA')),
  confianza             text CHECK (confianza IN ('ALTA', 'MEDIA', 'BAJA')),
  aprender              boolean NOT NULL DEFAULT true,
  pisar_equivalencia    boolean NOT NULL DEFAULT false,
  advertencia           text
);
CREATE INDEX IF NOT EXISTS idx_ingreso_items_ingreso
  ON public.ingreso_mercaderia_items (ingreso_id, linea);
CREATE INDEX IF NOT EXISTS idx_ingreso_items_producto
  ON public.ingreso_mercaderia_items (producto_id);

GRANT SELECT ON public.ingreso_mercaderia_items TO authenticated;
GRANT ALL ON public.ingreso_mercaderia_items TO service_role;
ALTER TABLE public.ingreso_mercaderia_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ingreso_items select" ON public.ingreso_mercaderia_items;
CREATE POLICY "ingreso_items select" ON public.ingreso_mercaderia_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ingresos_mercaderia i
                 WHERE i.id = ingreso_id
                   AND (public.is_admin(auth.uid()) OR i.sucursal_id = public.current_sucursal_id())));

-- ------------------------------------------------------------
-- 7. ÍNDICE DE TRIGRAMAS para el match difuso
--
-- El índice full-text que ya existe (idx_prods_nombre, to_tsvector('spanish',...))
-- se queda: sirve para buscar por palabras. Este es para el parecido con
-- abreviaturas ("Esm Sint Sat 4L Negro Victoria"), donde el stemming español no
-- llega. Los dos conviven.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_prods_nombre_trgm
  ON public.productos USING gin (nombre gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prods_codigo_trgm
  ON public.productos USING gin (codigo gin_trgm_ops);
