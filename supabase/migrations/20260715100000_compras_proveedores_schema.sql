-- ============================================================
-- COMPRAS Y PROVEEDORES — esquema
--
-- Circuito de compra de mercadería a proveedores: proveedores, compras (con el
-- comprobante EXTERNO del proveedor), sus ítems, la deuda con el proveedor (libro
-- de cuenta corriente) y los pagos. Espejo parcial de ventas/clientes.
--
-- Toda la escritura de las tablas transaccionales queda cerrada: sólo las RPC
-- SECURITY DEFINER (crear_compra, registrar_pago_proveedor, etc., en migraciones
-- siguientes) las tocan. proveedores se escribe directo, como clientes.
-- Ver docs/superpowers/specs/2026-07-15-compras-proveedores-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. ENUMS
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.proveedor_cc_tipo AS ENUM ('DEBITO', 'CREDITO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Entrada/salida de mercadería por compra (se usan en crear_compra / anular_compra).
ALTER TYPE public.tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'COMPRA';
ALTER TYPE public.tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'ANULACION_COMPRA';

-- ------------------------------------------------------------
-- 2. PROVEEDORES (espejo de clientes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.proveedores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razon_social      text NOT NULL,
  cuit_dni          text,
  condicion_iva     public.tipo_cliente NOT NULL DEFAULT 'RESPONSABLE_INSCRIPTO',
  telefono          text,
  email             text,
  direccion         text,
  condicion_cta_cte boolean NOT NULL DEFAULT false,
  activo            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proveedores_nombre ON public.proveedores (lower(razon_social));
CREATE UNIQUE INDEX IF NOT EXISTS uq_proveedores_cuit_activo
  ON public.proveedores ((regexp_replace(cuit_dni, '\D', '', 'g')))
  WHERE cuit_dni IS NOT NULL AND activo AND regexp_replace(cuit_dni, '\D', '', 'g') <> '';

GRANT SELECT, INSERT, UPDATE ON public.proveedores TO authenticated;
GRANT ALL ON public.proveedores TO service_role;
ALTER TABLE public.proveedores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prov read" ON public.proveedores;
CREATE POLICY "prov read" ON public.proveedores FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "prov write" ON public.proveedores;
CREATE POLICY "prov write" ON public.proveedores FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP TRIGGER IF EXISTS trg_proveedores_upd ON public.proveedores;
CREATE TRIGGER trg_proveedores_upd BEFORE UPDATE ON public.proveedores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Habilitar cuenta corriente a un proveedor es decisión de admin (como clientes).
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
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.condicion_cta_cte IS DISTINCT FROM OLD.condicion_cta_cte THEN
      RAISE EXCEPTION 'Sólo un administrador puede cambiar la cuenta corriente del proveedor';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_proveedores_guard_credito ON public.proveedores;
CREATE TRIGGER trg_proveedores_guard_credito
  BEFORE INSERT OR UPDATE ON public.proveedores
  FOR EACH ROW EXECUTE FUNCTION public.guard_proveedores_credito();

-- ------------------------------------------------------------
-- 3. COMPRAS (comprobante externo del proveedor)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compras (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id      uuid NOT NULL REFERENCES public.proveedores(id),
  sucursal_id       uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id        uuid NOT NULL REFERENCES auth.users(id),
  tipo_comprobante  text NOT NULL DEFAULT 'FACTURA_A'
    CHECK (tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C','NOTA_CREDITO','NOTA_DEBITO','REMITO','OTRO')),
  numero_comprobante text NOT NULL,
  fecha_comprobante date NOT NULL,
  fecha_carga       timestamptz NOT NULL DEFAULT now(),
  fecha_vencimiento date,
  subtotal_sin_iva  numeric(14,2) NOT NULL DEFAULT 0,
  iva_total         numeric(14,2) NOT NULL DEFAULT 0,
  percepciones      numeric(14,2) NOT NULL DEFAULT 0,
  total             numeric(14,2) NOT NULL DEFAULT 0,
  condicion         text NOT NULL CHECK (condicion IN ('CONTADO','CTA_CTE')),
  estado            text NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA','ANULADA')),
  caja_sesion_id    uuid REFERENCES public.caja_sesiones(id),
  observaciones     text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- No cargar dos veces la misma factura del proveedor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_compras_comprobante_activo
  ON public.compras (proveedor_id, tipo_comprobante, numero_comprobante)
  WHERE estado = 'ACTIVA';
CREATE INDEX IF NOT EXISTS idx_compras_proveedor ON public.compras (proveedor_id, fecha_comprobante DESC);
CREATE INDEX IF NOT EXISTS idx_compras_sucursal_fecha ON public.compras (sucursal_id, fecha_comprobante DESC);
CREATE INDEX IF NOT EXISTS idx_compras_caja_sesion ON public.compras (caja_sesion_id);

GRANT SELECT ON public.compras TO authenticated;
GRANT ALL ON public.compras TO service_role;
ALTER TABLE public.compras ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "compras select" ON public.compras;
CREATE POLICY "compras select" ON public.compras FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());

-- ------------------------------------------------------------
-- 4. COMPRA_ITEMS (snapshot de costo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.compra_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id              uuid NOT NULL REFERENCES public.compras(id) ON DELETE CASCADE,
  producto_id            uuid NOT NULL REFERENCES public.productos(id),
  codigo                 text NOT NULL,
  descripcion            text NOT NULL,
  cantidad               numeric(14,2) NOT NULL,
  costo_unitario_sin_iva numeric(14,2) NOT NULL,
  iva_porcentaje         numeric(5,2) NOT NULL,
  subtotal_sin_iva       numeric(14,2) NOT NULL,
  iva_monto              numeric(14,2) NOT NULL,
  subtotal_con_iva       numeric(14,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compra_items_compra ON public.compra_items (compra_id);
CREATE INDEX IF NOT EXISTS idx_compra_items_producto ON public.compra_items (producto_id);
GRANT SELECT ON public.compra_items TO authenticated;
GRANT ALL ON public.compra_items TO service_role;
ALTER TABLE public.compra_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "compra_items select" ON public.compra_items;
CREATE POLICY "compra_items select" ON public.compra_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.compras c WHERE c.id = compra_id
                 AND (public.is_admin(auth.uid()) OR c.sucursal_id = public.current_sucursal_id())));

-- ------------------------------------------------------------
-- 5. PROVEEDOR_PAGOS (pagos al proveedor — salida de caja)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.proveedor_pagos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id   uuid NOT NULL REFERENCES public.proveedores(id),
  sucursal_id    uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id     uuid NOT NULL REFERENCES auth.users(id),
  fecha          timestamptz NOT NULL DEFAULT now(),
  monto          numeric(14,2) NOT NULL CHECK (monto > 0),
  forma_pago     text NOT NULL
    CHECK (forma_pago IN ('EFECTIVO','TRANSFERENCIA','TARJETA_DEBITO','TARJETA_CREDITO','MERCADO_PAGO','CHEQUE')),
  detalle        jsonb NOT NULL DEFAULT '{}'::jsonb,
  caja_sesion_id uuid REFERENCES public.caja_sesiones(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_prov ON public.proveedor_pagos (proveedor_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_sucursal_fecha ON public.proveedor_pagos (sucursal_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_proveedor_pagos_caja ON public.proveedor_pagos (caja_sesion_id);
GRANT SELECT ON public.proveedor_pagos TO authenticated;
GRANT ALL ON public.proveedor_pagos TO service_role;
ALTER TABLE public.proveedor_pagos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prov_pagos select" ON public.proveedor_pagos;
CREATE POLICY "prov_pagos select" ON public.proveedor_pagos FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());

-- ------------------------------------------------------------
-- 6. PROVEEDOR_CC_MOVIMIENTOS (libro de la deuda; saldo derivado)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.proveedor_cc_movimientos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proveedor_id   uuid NOT NULL REFERENCES public.proveedores(id),
  sucursal_id    uuid NOT NULL REFERENCES public.sucursales(id),
  tipo           public.proveedor_cc_tipo NOT NULL,
  monto          numeric(14,2) NOT NULL CHECK (monto > 0),
  estado         text NOT NULL DEFAULT 'CONFIRMADO' CHECK (estado IN ('CONFIRMADO','ANULADO')),
  compra_id      uuid UNIQUE REFERENCES public.compras(id) ON DELETE CASCADE,
  pago_id        uuid UNIQUE REFERENCES public.proveedor_pagos(id) ON DELETE CASCADE,
  forma_pago     text,
  descripcion    text,
  usuario_id     uuid REFERENCES auth.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Cada movimiento tiene EXACTAMENTE un origen, y coincide con su tipo:
  -- DEBITO viene siempre de una compra, CREDITO siempre de un pago. Así no puede
  -- colarse una fila huérfana (sin origen) ni una con ambos, que ensuciaría el saldo.
  CONSTRAINT chk_prov_cc_origen CHECK (
    (tipo = 'DEBITO'  AND compra_id IS NOT NULL AND pago_id IS NULL) OR
    (tipo = 'CREDITO' AND pago_id   IS NOT NULL AND compra_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_prov_cc_prov ON public.proveedor_cc_movimientos (proveedor_id);
GRANT SELECT ON public.proveedor_cc_movimientos TO authenticated;
GRANT ALL ON public.proveedor_cc_movimientos TO service_role;
ALTER TABLE public.proveedor_cc_movimientos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "prov_cc select" ON public.proveedor_cc_movimientos;
-- La deuda con el proveedor es global de la empresa: legible por cualquier autenticado.
CREATE POLICY "prov_cc select" ON public.proveedor_cc_movimientos FOR SELECT TO authenticated USING (true);
