
-- 1) Settings globales
CREATE TABLE IF NOT EXISTS public.settings (
  id boolean PRIMARY KEY DEFAULT true,
  markup_default_porcentaje numeric(6,2) NOT NULL DEFAULT 50,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = true)
);
GRANT SELECT ON public.settings TO authenticated;
GRANT ALL ON public.settings TO service_role;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "auth read settings" ON public.settings;
CREATE POLICY "auth read settings" ON public.settings FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "admin write settings" ON public.settings;
CREATE POLICY "admin write settings" ON public.settings FOR ALL TO authenticated
  USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
INSERT INTO public.settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 2) Productos: precio fábrica + markup individual
ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS precio_fabrica numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_porcentaje numeric(6,2);

-- 3) Clientes: bandera cuenta corriente
ALTER TABLE public.clientes
  ADD COLUMN IF NOT EXISTS condicion_cta_cte boolean NOT NULL DEFAULT false;

-- 4) Nuevos tipos de comprobante
ALTER TYPE tipo_comprobante ADD VALUE IF NOT EXISTS 'NOTA_DEBITO';
ALTER TYPE tipo_comprobante ADD VALUE IF NOT EXISTS 'FAC_INTERNA_CTA_CTE';
ALTER TYPE tipo_comprobante ADD VALUE IF NOT EXISTS 'REMITO_OBRA';

-- 5) Ventas: nombre de obra (opcional)
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS nombre_obra text;

-- 6) Rendiciones de caja: efectivo retirado/dejado
ALTER TABLE public.rendiciones_caja
  ADD COLUMN IF NOT EXISTS efectivo_retirado numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS efectivo_dejado numeric(14,2) NOT NULL DEFAULT 0;

-- Asegurar policies que faltan en rendiciones_caja (en la migra anterior quedaron sin)
DROP POLICY IF EXISTS "rendiciones select" ON public.rendiciones_caja;
DROP POLICY IF EXISTS "rendiciones write" ON public.rendiciones_caja;
CREATE POLICY "rendiciones select" ON public.rendiciones_caja FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());
CREATE POLICY "rendiciones write" ON public.rendiciones_caja FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id())
  WITH CHECK (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());

-- 7) Cobranzas cuenta corriente
CREATE TABLE IF NOT EXISTS public.cobranzas_cta_cte (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id uuid NOT NULL REFERENCES public.clientes(id),
  sucursal_id uuid NOT NULL REFERENCES public.sucursales(id),
  usuario_id uuid NOT NULL REFERENCES auth.users(id),
  fecha timestamptz NOT NULL DEFAULT now(),
  monto numeric(14,2) NOT NULL,
  forma_pago text NOT NULL,
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  observaciones text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cobranzas_cta_cte TO authenticated;
GRANT ALL ON public.cobranzas_cta_cte TO service_role;
CREATE INDEX IF NOT EXISTS idx_cobranzas_cliente ON public.cobranzas_cta_cte (cliente_id);
CREATE INDEX IF NOT EXISTS idx_cobranzas_sucfecha ON public.cobranzas_cta_cte (sucursal_id, fecha DESC);
ALTER TABLE public.cobranzas_cta_cte ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cobranzas select" ON public.cobranzas_cta_cte FOR SELECT TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());
CREATE POLICY "cobranzas write" ON public.cobranzas_cta_cte FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id())
  WITH CHECK (public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id());
CREATE TRIGGER trg_cobranzas_upd BEFORE UPDATE ON public.cobranzas_cta_cte
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 8) Actualizar generador de números para cubrir nuevos tipos
CREATE OR REPLACE FUNCTION public.next_comprobante_numero(_sucursal_id uuid, _tipo tipo_comprobante)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _next INTEGER; _prefix_suc TEXT; _prefix_tipo TEXT;
BEGIN
  INSERT INTO public.comprobante_secuencias (sucursal_id, tipo, ultimo_numero)
  VALUES (_sucursal_id, _tipo, 1)
  ON CONFLICT (sucursal_id, tipo) DO UPDATE SET ultimo_numero = comprobante_secuencias.ultimo_numero + 1
  RETURNING ultimo_numero INTO _next;

  SELECT CASE codigo WHEN 'OHIGGINS' THEN 'OHI' WHEN 'GENERALPAZ' THEN 'GPZ' END INTO _prefix_suc
  FROM public.sucursales WHERE id = _sucursal_id;

  _prefix_tipo := CASE _tipo
    WHEN 'FACTURA_A' THEN 'FAIV'
    WHEN 'FACTURA_B' THEN 'FVTA'
    WHEN 'NOTA_CREDITO' THEN 'NCIV'
    WHEN 'NOTA_DEBITO' THEN 'NDIV'
    WHEN 'REMITO' THEN 'REM'
    WHEN 'REMITO_OBRA' THEN 'ROBR'
    WHEN 'FAC_INTERNA_CTA_CTE' THEN 'FICC'
  END;

  RETURN _prefix_suc || '-' || _prefix_tipo || '-' || lpad(_next::text, 4, '0');
END; $$;
