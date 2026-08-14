-- ============================================================
-- Quién factura: una fila por persona jurídica
--
-- EL PEDIDO
-- Leo: "que en los presupuestos y facturas que imprimimos salgan los datos como
-- celular, dirección". Hoy los impresos salen pelados porque los dos PDF leen el
-- emisor de `fiscal_config`, que en producción está entero en NULL.
--
-- POR QUÉ UNA TABLA Y NO DOS COLUMNAS EN `sucursales`
-- Los datos que pasó Leo son de DOS razones sociales:
--
--   General Paz  →  Aplicaciones y Servicios SRL
--   O'Higgins    →  Grupo Casa Forma SAS
--
-- Una SRL y una SAS son dos personas jurídicas: tienen CUIT distinto por
-- definición. Y `fiscal_config.id` es un boolean — una sola fila, un solo
-- emisor. No alcanza.
--
-- La primera versión de esto proponía meter `razon_social` y `cuit` como
-- columnas de `sucursales` y dejar el modelo para cuando llegara el certificado
-- de AFIP. El review lo rechazó con razón: el modelo NO depende del certificado,
-- y postergarlo obliga a rehacer emisión, puntos de venta, snapshots y
-- reimpresiones bajo presión el día que AFIP se habilite.
--
-- QUÉ SIGUE EN `fiscal_config`
-- Las credenciales de AFIP (certificado y clave), que hoy están vacías. Cuando
-- llegue el certificado hay que moverlas a 1:1 por emisor y revisar
-- `puntos_venta`, que tiene UNIQUE(numero, modo) atado sólo a sucursal
-- (20260713122000_facturacion_electronica.sql:85-97) y le impediría a dos CUIT
-- usar el mismo número de punto de venta, cosa perfectamente posible. Está en el
-- backlog.
--
-- QUÉ NO VA ACÁ
-- La dirección y el teléfono se quedan en `sucursales`: son datos de contacto
-- del LOCAL, no de la persona jurídica. Como cada sucursal pertenece a exactamente
-- un emisor, el encabezado impreso nunca puede mezclar la razón social de uno con
-- el teléfono del otro.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.emisores (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razon_social       text NOT NULL,
  -- Todo lo fiscal es nullable a propósito: hoy sólo se conocen el nombre y el
  -- domicilio. Se completa cuando estén los datos, sin bloquear el impreso.
  cuit               text,
  domicilio_fiscal   text,
  condicion_iva      text,
  ingresos_brutos    text,
  inicio_actividades date,
  -- El logo va como data URL (PNG o JPEG en base64), no en el bucket de storage.
  -- Se pide SÓLO al generar un PDF, nunca en una consulta de listado, así que no
  -- viaja en cada carga de pantalla ni se queda en la caché de react-query. El
  -- tope y las dimensiones se validan al subirlo, del lado del front.
  logo               text,
  activo             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_emisores_upd ON public.emisores;
CREATE TRIGGER trg_emisores_upd BEFORE UPDATE ON public.emisores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.sucursales
  ADD COLUMN IF NOT EXISTS emisor_id uuid REFERENCES public.emisores(id);
CREATE INDEX IF NOT EXISTS idx_sucursales_emisor ON public.sucursales (emisor_id);

-- ------------------------------------------------------------
-- Los datos reales
-- ------------------------------------------------------------
-- Van acá y no cargados a mano en producción para que la base local y la de
-- producción queden iguales, y para que quede asentado de dónde salieron: los
-- pasó Leo el 13/08/2026, copiados de los impresos del sistema viejo.
--
-- La razón social es única: es lo que identifica a la persona jurídica y es lo
-- que hace que este INSERT sea idempotente de verdad. Un `ON CONFLICT DO NOTHING`
-- sin constraint no hace nada y la migración duplicaría en cada corrida —
-- verificado: la primera versión de esto dejó 4 emisores al correrla dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_emisores_razon_social
  ON public.emisores (razon_social);

INSERT INTO public.emisores (razon_social, domicilio_fiscal) VALUES
  ('Aplicaciones y Servicios SRL', 'Sarmiento 1398 - B° Gral Paz - Córdoba'),
  ('Grupo Casa Forma SAS',         'O''Higgins 5450 - Córdoba')
ON CONFLICT (razon_social) DO UPDATE
  SET domicilio_fiscal = EXCLUDED.domicilio_fiscal;

UPDATE public.sucursales s SET
  emisor_id = e.id,
  direccion = e.domicilio_fiscal,
  telefono  = t.tel
FROM public.emisores e
JOIN (VALUES
  ('Aplicaciones y Servicios SRL', 'GENERALPAZ', '3513229459'),
  ('Grupo Casa Forma SAS',         'OHIGGINS',   '3512146766')
) AS t(razon, codigo, tel) ON t.razon = e.razon_social
WHERE s.codigo::text = t.codigo;

-- ------------------------------------------------------------
-- Permisos
-- ------------------------------------------------------------
-- Lectura para cualquiera que esté adentro: los impresos la necesitan. La
-- escritura NO se abre por RLS —va por server function de admin, igual que
-- `fiscal_config`— así que no hay policy de INSERT/UPDATE.
ALTER TABLE public.emisores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS emisores_lectura ON public.emisores;
CREATE POLICY emisores_lectura ON public.emisores
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.emisores TO authenticated;
GRANT ALL    ON public.emisores TO service_role;
