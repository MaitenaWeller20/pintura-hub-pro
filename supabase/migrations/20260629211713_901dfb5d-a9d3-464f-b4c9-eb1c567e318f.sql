
-- ============================================================
-- PinturaGest / CasaForma — Schema completo Fase 1
-- ============================================================

-- ---------- ENUMS ----------
CREATE TYPE public.app_role AS ENUM ('admin', 'empleado');
CREATE TYPE public.sucursal_codigo AS ENUM ('OHIGGINS', 'GENERALPAZ');
CREATE TYPE public.tipo_comprobante AS ENUM ('FACTURA_A', 'FACTURA_B', 'NOTA_CREDITO', 'REMITO');
CREATE TYPE public.condicion_venta AS ENUM ('CONTADO', 'CTA_CTE');
CREATE TYPE public.estado_pago AS ENUM ('PAGADO', 'PARCIAL', 'PENDIENTE');
CREATE TYPE public.tipo_cliente AS ENUM ('CONSUMIDOR_FINAL', 'RESPONSABLE_INSCRIPTO', 'MONOTRIBUTISTA', 'EXENTO');
CREATE TYPE public.forma_pago AS ENUM ('EFECTIVO','TRANSFERENCIA','TARJETA_DEBITO','TARJETA_CREDITO','MERCADO_PAGO','CHEQUE','CTA_CTE');
CREATE TYPE public.tipo_movimiento_stock AS ENUM ('VENTA','AJUSTE','TRANSFERENCIA_OUT','TRANSFERENCIA_IN','INGRESO_INICIAL','ANULACION_VENTA');
CREATE TYPE public.estado_remito AS ENUM ('PENDIENTE','APROBADO','RECHAZADO');
CREATE TYPE public.estado_venta AS ENUM ('ACTIVA','ANULADA');

-- ---------- UPDATED_AT helper ----------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- ---------- SUCURSALES ----------
CREATE TABLE public.sucursales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo public.sucursal_codigo NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  numero TEXT NOT NULL UNIQUE, -- 0001, 0003
  direccion TEXT,
  telefono TEXT,
  activa BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.sucursales TO authenticated;
GRANT ALL ON public.sucursales TO service_role;
ALTER TABLE public.sucursales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read sucursales" ON public.sucursales FOR SELECT TO authenticated USING (true);
CREATE TRIGGER trg_sucursales_upd BEFORE UPDATE ON public.sucursales FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- PROFILES ----------
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  nombre_completo TEXT,
  sucursal_id UUID REFERENCES public.sucursales(id),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "user update own profile" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());
CREATE TRIGGER trg_profiles_upd BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- USER_ROLES ----------
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read user_roles" ON public.user_roles FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.is_admin(_user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin'::public.app_role)
$$;

CREATE OR REPLACE FUNCTION public.current_sucursal_id()
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT sucursal_id FROM public.profiles WHERE id = auth.uid()
$$;

-- ---------- CATEGORIAS / MARCAS ----------
CREATE TABLE public.categorias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.categorias TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.categorias TO authenticated;
GRANT ALL ON public.categorias TO service_role;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read cats" ON public.categorias FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write cats" ON public.categorias FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

CREATE TABLE public.marcas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.marcas TO authenticated;
GRANT ALL ON public.marcas TO service_role;
ALTER TABLE public.marcas ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read marcas" ON public.marcas FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write marcas" ON public.marcas FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));

-- ---------- PRODUCTOS ----------
CREATE TABLE public.productos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL UNIQUE,
  codigo_barras TEXT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  categoria_id UUID REFERENCES public.categorias(id),
  marca_id UUID REFERENCES public.marcas(id),
  unidad_medida TEXT NOT NULL DEFAULT 'unidad',
  precio_sin_iva NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 21,
  stock_minimo NUMERIC(14,2) NOT NULL DEFAULT 0,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.productos TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.productos TO authenticated;
GRANT ALL ON public.productos TO service_role;
ALTER TABLE public.productos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read prods" ON public.productos FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write prods" ON public.productos FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
CREATE TRIGGER trg_prods_upd BEFORE UPDATE ON public.productos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE INDEX idx_prods_nombre ON public.productos USING gin (to_tsvector('spanish', nombre));

-- ---------- STOCK POR SUCURSAL ----------
CREATE TABLE public.stock_sucursal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id UUID NOT NULL REFERENCES public.productos(id) ON DELETE CASCADE,
  sucursal_id UUID NOT NULL REFERENCES public.sucursales(id) ON DELETE CASCADE,
  cantidad NUMERIC(14,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (producto_id, sucursal_id)
);
GRANT SELECT, INSERT, UPDATE ON public.stock_sucursal TO authenticated;
GRANT ALL ON public.stock_sucursal TO service_role;
ALTER TABLE public.stock_sucursal ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read stock" ON public.stock_sucursal FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin write stock" ON public.stock_sucursal FOR ALL TO authenticated USING (public.is_admin(auth.uid())) WITH CHECK (public.is_admin(auth.uid()));
CREATE TRIGGER trg_stock_upd BEFORE UPDATE ON public.stock_sucursal FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- HISTORIAL DE MOVIMIENTOS DE STOCK ----------
CREATE TABLE public.stock_movimientos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  sucursal_id UUID NOT NULL REFERENCES public.sucursales(id),
  tipo public.tipo_movimiento_stock NOT NULL,
  cantidad NUMERIC(14,2) NOT NULL, -- positivo entrada, negativo salida
  cantidad_anterior NUMERIC(14,2),
  cantidad_nueva NUMERIC(14,2),
  motivo TEXT,
  referencia_id UUID, -- venta_id, remito_id, ajuste_id
  usuario_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.stock_movimientos TO authenticated;
GRANT ALL ON public.stock_movimientos TO service_role;
ALTER TABLE public.stock_movimientos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read movs" ON public.stock_movimientos FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth insert movs" ON public.stock_movimientos FOR INSERT TO authenticated WITH CHECK (true);

-- ---------- CLIENTES ----------
CREATE TABLE public.clientes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  razon_social TEXT NOT NULL,
  cuit_dni TEXT,
  tipo public.tipo_cliente NOT NULL DEFAULT 'CONSUMIDOR_FINAL',
  telefono TEXT,
  email TEXT,
  direccion TEXT,
  sucursal_habitual_id UUID REFERENCES public.sucursales(id),
  limite_credito NUMERIC(14,2),
  es_generico BOOLEAN NOT NULL DEFAULT false,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clientes_nombre ON public.clientes (lower(razon_social));
CREATE INDEX idx_clientes_cuit ON public.clientes (cuit_dni);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clientes TO authenticated;
GRANT ALL ON public.clientes TO service_role;
ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth manage clientes" ON public.clientes FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE TRIGGER trg_clientes_upd BEFORE UPDATE ON public.clientes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- VENTAS ----------
CREATE TABLE public.ventas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id UUID NOT NULL REFERENCES public.sucursales(id),
  cliente_id UUID NOT NULL REFERENCES public.clientes(id),
  usuario_id UUID NOT NULL REFERENCES auth.users(id),
  fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
  numero_comprobante TEXT NOT NULL UNIQUE, -- OHI-FAIV-0001
  tipo_comprobante public.tipo_comprobante NOT NULL,
  condicion_venta public.condicion_venta NOT NULL DEFAULT 'CONTADO',
  subtotal_sin_iva NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  percepciones NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_pagado NUMERIC(14,2) NOT NULL DEFAULT 0,
  estado_pago public.estado_pago NOT NULL DEFAULT 'PENDIENTE',
  estado public.estado_venta NOT NULL DEFAULT 'ACTIVA',
  venta_anulada_por UUID REFERENCES public.ventas(id), -- nota de crédito que la anuló
  observaciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ventas_fecha ON public.ventas (fecha DESC);
CREATE INDEX idx_ventas_sucursal ON public.ventas (sucursal_id);
CREATE INDEX idx_ventas_cliente ON public.ventas (cliente_id);
GRANT SELECT, INSERT, UPDATE ON public.ventas TO authenticated;
GRANT ALL ON public.ventas TO service_role;
ALTER TABLE public.ventas ENABLE ROW LEVEL SECURITY;
-- Admin ve todo; empleado ve sólo su sucursal
CREATE POLICY "ventas select" ON public.ventas FOR SELECT TO authenticated USING (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
);
CREATE POLICY "ventas insert" ON public.ventas FOR INSERT TO authenticated WITH CHECK (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
);
CREATE POLICY "ventas update" ON public.ventas FOR UPDATE TO authenticated USING (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
);
CREATE TRIGGER trg_ventas_upd BEFORE UPDATE ON public.ventas FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- VENTA ITEMS ----------
CREATE TABLE public.venta_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id UUID NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  codigo TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  cantidad NUMERIC(14,2) NOT NULL,
  precio_unitario_sin_iva NUMERIC(14,2) NOT NULL,
  iva_porcentaje NUMERIC(5,2) NOT NULL,
  descuento_porcentaje NUMERIC(5,2) NOT NULL DEFAULT 0,
  subtotal_sin_iva NUMERIC(14,2) NOT NULL,
  iva_monto NUMERIC(14,2) NOT NULL,
  subtotal_con_iva NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vi_venta ON public.venta_items(venta_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.venta_items TO authenticated;
GRANT ALL ON public.venta_items TO service_role;
ALTER TABLE public.venta_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vi select" ON public.venta_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
);
CREATE POLICY "vi write" ON public.venta_items FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
);

-- ---------- VENTA PAGOS ----------
CREATE TABLE public.venta_pagos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id UUID NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  forma_pago public.forma_pago NOT NULL,
  monto NUMERIC(14,2) NOT NULL,
  detalle JSONB NOT NULL DEFAULT '{}'::jsonb, -- banco, tarjeta, nro cheque, fecha cobro, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vp_venta ON public.venta_pagos(venta_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.venta_pagos TO authenticated;
GRANT ALL ON public.venta_pagos TO service_role;
ALTER TABLE public.venta_pagos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vp select" ON public.venta_pagos FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
);
CREATE POLICY "vp write" ON public.venta_pagos FOR ALL TO authenticated USING (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.ventas v WHERE v.id = venta_id
          AND (public.is_admin(auth.uid()) OR v.sucursal_id = public.current_sucursal_id()))
);

-- ---------- REMITOS DE TRANSFERENCIA ----------
CREATE TABLE public.remitos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero TEXT NOT NULL UNIQUE,
  sucursal_origen_id UUID NOT NULL REFERENCES public.sucursales(id),
  sucursal_destino_id UUID NOT NULL REFERENCES public.sucursales(id),
  estado public.estado_remito NOT NULL DEFAULT 'PENDIENTE',
  creado_por UUID NOT NULL REFERENCES auth.users(id),
  aprobado_por UUID REFERENCES auth.users(id),
  fecha_aprobacion TIMESTAMPTZ,
  motivo_rechazo TEXT,
  observaciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.remitos TO authenticated;
GRANT ALL ON public.remitos TO service_role;
ALTER TABLE public.remitos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "remitos select" ON public.remitos FOR SELECT TO authenticated USING (true);
CREATE POLICY "remitos insert" ON public.remitos FOR INSERT TO authenticated WITH CHECK (
  creado_por = auth.uid()
);
CREATE POLICY "remitos update admin" ON public.remitos FOR UPDATE TO authenticated USING (public.is_admin(auth.uid()));
CREATE TRIGGER trg_remitos_upd BEFORE UPDATE ON public.remitos FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.remito_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remito_id UUID NOT NULL REFERENCES public.remitos(id) ON DELETE CASCADE,
  producto_id UUID NOT NULL REFERENCES public.productos(id),
  cantidad NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.remito_items TO authenticated;
GRANT ALL ON public.remito_items TO service_role;
ALTER TABLE public.remito_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ri select" ON public.remito_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "ri insert" ON public.remito_items FOR INSERT TO authenticated WITH CHECK (
  EXISTS (SELECT 1 FROM public.remitos r WHERE r.id = remito_id AND r.creado_por = auth.uid() AND r.estado = 'PENDIENTE')
);

-- ---------- RENDICIONES DE CAJA ----------
CREATE TABLE public.rendiciones_caja (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id UUID NOT NULL REFERENCES public.sucursales(id),
  fecha DATE NOT NULL,
  usuario_id UUID NOT NULL REFERENCES auth.users(id),
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_efectivo NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_transferencia NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_debito NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_credito NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_mp NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cheque NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_cta_cte NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_sistema NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_declarado NUMERIC(14,2) NOT NULL DEFAULT 0,
  diferencia NUMERIC(14,2) NOT NULL DEFAULT 0,
  observaciones TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sucursal_id, fecha, usuario_id)
);
GRANT SELECT, INSERT, UPDATE ON public.rendiciones_caja TO authenticated;
GRANT ALL ON public.rendiciones_caja TO service_role;
ALTER TABLE public.rendiciones_caja ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rc select" ON public.rendiciones_caja FOR SELECT TO authenticated USING (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
);
CREATE POLICY "rc write" ON public.rendiciones_caja FOR ALL TO authenticated USING (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
) WITH CHECK (
  public.is_admin(auth.uid()) OR sucursal_id = public.current_sucursal_id()
);
CREATE TRIGGER trg_rc_upd BEFORE UPDATE ON public.rendiciones_caja FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- SECUENCIA NUMERO COMPROBANTE ----------
CREATE TABLE public.comprobante_secuencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id UUID NOT NULL REFERENCES public.sucursales(id),
  tipo public.tipo_comprobante NOT NULL,
  ultimo_numero INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sucursal_id, tipo)
);
GRANT SELECT, INSERT, UPDATE ON public.comprobante_secuencias TO authenticated;
GRANT ALL ON public.comprobante_secuencias TO service_role;
ALTER TABLE public.comprobante_secuencias ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cs read" ON public.comprobante_secuencias FOR SELECT TO authenticated USING (true);
CREATE POLICY "cs write" ON public.comprobante_secuencias FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.next_comprobante_numero(_sucursal_id UUID, _tipo public.tipo_comprobante)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _next INTEGER;
  _prefix_suc TEXT;
  _prefix_tipo TEXT;
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
    WHEN 'REMITO' THEN 'REM'
  END;

  RETURN _prefix_suc || '-' || _prefix_tipo || '-' || lpad(_next::text, 4, '0');
END; $$;

-- ---------- TRIGGER auto-perfil al crear user ----------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, username, nombre_completo)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email,'@',1)),
          COALESCE(NEW.raw_user_meta_data->>'nombre_completo', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ---------- SEED inicial: sucursales + cliente genéricos + categorías/marcas + productos ejemplo ----------
INSERT INTO public.sucursales (codigo, nombre, numero, direccion) VALUES
  ('OHIGGINS','CasaForma O''Higgins','0001','O''Higgins'),
  ('GENERALPAZ','CasaForma General Paz','0003','General Paz');

INSERT INTO public.clientes (razon_social, tipo, es_generico, sucursal_habitual_id) VALUES
  ('Consumidor Final','CONSUMIDOR_FINAL', true, NULL),
  ('C.F. 101','CONSUMIDOR_FINAL', true, (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS')),
  ('C.F. 104','CONSUMIDOR_FINAL', true, (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ'));

INSERT INTO public.categorias (nombre) VALUES
  ('Pinturas látex'),('Esmaltes'),('Diluyentes'),('Accesorios'),('Rodillos y pinceles'),('Impermeabilizantes');

INSERT INTO public.marcas (nombre) VALUES
  ('Alba'),('Sherwin Williams'),('Sinteplast'),('Tersuave'),('Plavicon'),('Genérica');

-- Productos de ejemplo (30)
DO $$
DECLARE
  c_latex UUID := (SELECT id FROM public.categorias WHERE nombre='Pinturas látex');
  c_esm UUID := (SELECT id FROM public.categorias WHERE nombre='Esmaltes');
  c_dil UUID := (SELECT id FROM public.categorias WHERE nombre='Diluyentes');
  c_acc UUID := (SELECT id FROM public.categorias WHERE nombre='Accesorios');
  c_rod UUID := (SELECT id FROM public.categorias WHERE nombre='Rodillos y pinceles');
  c_imp UUID := (SELECT id FROM public.categorias WHERE nombre='Impermeabilizantes');
  m_alba UUID := (SELECT id FROM public.marcas WHERE nombre='Alba');
  m_sw UUID := (SELECT id FROM public.marcas WHERE nombre='Sherwin Williams');
  m_sint UUID := (SELECT id FROM public.marcas WHERE nombre='Sinteplast');
  m_ter UUID := (SELECT id FROM public.marcas WHERE nombre='Tersuave');
  m_pla UUID := (SELECT id FROM public.marcas WHERE nombre='Plavicon');
  m_gen UUID := (SELECT id FROM public.marcas WHERE nombre='Genérica');
  s_ohi UUID := (SELECT id FROM public.sucursales WHERE codigo='OHIGGINS');
  s_gpz UUID := (SELECT id FROM public.sucursales WHERE codigo='GENERALPAZ');
  p_id UUID;
  prod RECORD;
BEGIN
  FOR prod IN SELECT * FROM (VALUES
    ('LTX-001','Látex Interior Blanco 20L', c_latex, m_alba, 'litro', 45000, 21, 5),
    ('LTX-002','Látex Interior Blanco 10L', c_latex, m_alba, 'litro', 24000, 21, 5),
    ('LTX-003','Látex Interior Blanco 4L', c_latex, m_alba, 'litro', 11000, 21, 8),
    ('LTX-004','Látex Interior Blanco 1L', c_latex, m_alba, 'litro', 3500, 21, 10),
    ('LTX-005','Látex Exterior Blanco 20L', c_latex, m_sw, 'litro', 62000, 21, 4),
    ('LTX-006','Látex Exterior Blanco 10L', c_latex, m_sw, 'litro', 33000, 21, 4),
    ('LTX-007','Látex Lavable Premium 20L', c_latex, m_sint, 'litro', 70000, 21, 3),
    ('LTX-008','Látex Lavable Premium 10L', c_latex, m_sint, 'litro', 38000, 21, 3),
    ('ESM-001','Esmalte Sintético Brillante Blanco 4L', c_esm, m_ter, 'litro', 22000, 21, 5),
    ('ESM-002','Esmalte Sintético Brillante Blanco 1L', c_esm, m_ter, 'litro', 6500, 21, 8),
    ('ESM-003','Esmalte Sintético Brillante Negro 1L', c_esm, m_ter, 'litro', 6500, 21, 6),
    ('ESM-004','Esmalte al Agua Blanco 4L', c_esm, m_sint, 'litro', 19000, 21, 5),
    ('ESM-005','Esmalte al Agua Blanco 1L', c_esm, m_sint, 'litro', 5500, 21, 8),
    ('DIL-001','Aguarrás Mineral 1L', c_dil, m_gen, 'litro', 2200, 21, 12),
    ('DIL-002','Aguarrás Mineral 4L', c_dil, m_gen, 'litro', 8000, 21, 6),
    ('DIL-003','Thinner Universal 1L', c_dil, m_gen, 'litro', 2400, 21, 10),
    ('DIL-004','Thinner Universal 4L', c_dil, m_gen, 'litro', 8800, 21, 5),
    ('ACC-001','Cinta de papel 24mm x 40m', c_acc, m_gen, 'unidad', 1200, 21, 20),
    ('ACC-002','Cinta de papel 48mm x 40m', c_acc, m_gen, 'unidad', 2200, 21, 15),
    ('ACC-003','Bandeja plástica chica', c_acc, m_gen, 'unidad', 1800, 21, 10),
    ('ACC-004','Bandeja plástica grande', c_acc, m_gen, 'unidad', 3200, 21, 8),
    ('ACC-005','Espátula 4''', c_acc, m_gen, 'unidad', 2500, 21, 10),
    ('ROD-001','Rodillo de lana 22cm', c_rod, m_gen, 'unidad', 3500, 21, 12),
    ('ROD-002','Repuesto rodillo lana 22cm', c_rod, m_gen, 'unidad', 1800, 21, 20),
    ('ROD-003','Pincel cerda 1''', c_rod, m_gen, 'unidad', 1200, 21, 15),
    ('ROD-004','Pincel cerda 2''', c_rod, m_gen, 'unidad', 1800, 21, 15),
    ('ROD-005','Pincel cerda 3''', c_rod, m_gen, 'unidad', 2600, 21, 10),
    ('IMP-001','Membrana líquida 20Kg', c_imp, m_pla, 'kg', 58000, 21, 3),
    ('IMP-002','Membrana líquida 10Kg', c_imp, m_pla, 'kg', 32000, 21, 4),
    ('IMP-003','Sellador acrílico 4L', c_imp, m_pla, 'litro', 18000, 21, 5)
  ) AS t(codigo,nombre,cat,marca,um,precio,iva,smin)
  LOOP
    INSERT INTO public.productos (codigo,nombre,categoria_id,marca_id,unidad_medida,precio_sin_iva,iva_porcentaje,stock_minimo)
    VALUES (prod.codigo,prod.nombre,prod.cat,prod.marca,prod.um,prod.precio,prod.iva,prod.smin)
    RETURNING id INTO p_id;
    INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad) VALUES
      (p_id, s_ohi, floor(random()*30)+5),
      (p_id, s_gpz, floor(random()*30)+5);
  END LOOP;
END $$;
