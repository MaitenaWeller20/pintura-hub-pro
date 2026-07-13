-- ============================================================
-- Facturación electrónica AFIP / ARCA
--
-- Portado de lubricentro-sistema y MesaYa, que ya facturan en producción.
-- Decisiones que vienen de cicatrices de esos dos sistemas:
--
--   * El certificado y la clave privada se guardan CIFRADOS EN LA BASE, no en
--     archivos. Vercel no tiene filesystem persistente: cualquier diseño con
--     ARCA_CERT_PATH se cae al primer deploy.
--
--   * El ticket de acceso de AFIP (TA) también va en la base. Dura 12h y AFIP
--     RECHAZA un segundo login mientras haya uno válido ("coe.alreadyAuthenticated").
--     En serverless cada cold start es un proceso nuevo, así que una caché en RAM
--     (lo que hace lubricentro) genera una tormenta de logins. Va a Postgres.
--
--   * La numeración fiscal la manda AFIP, no nosotros. Es SEPARADA de la
--     numeración interna (OHI-FVTA-0001) que ya usa el sistema para el mostrador.
--
--   * REMITO, REMITO_OBRA y FAC_INTERNA_CTA_CTE son documentos INTERNOS.
--     No son comprobantes fiscales y NO se mandan a AFIP.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Factura C (emisor monotributista)
-- ------------------------------------------------------------
-- El enum actual sólo tiene A y B. Si el CUIT emisor es monotributo, AFIP exige
-- Factura C. Sin esto, un monotributista no puede facturar.
ALTER TYPE public.tipo_comprobante ADD VALUE IF NOT EXISTS 'FACTURA_C';


-- ------------------------------------------------------------
-- 2. Configuración fiscal del emisor (singleton)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fiscal_config (
  id                boolean PRIMARY KEY DEFAULT true,
  cuit              text,
  razon_social      text,
  nombre_fantasia   text,
  domicilio_fiscal  text,
  condicion_iva     text NOT NULL DEFAULT 'RESPONSABLE_INSCRIPTO'
                    CHECK (condicion_iva IN ('RESPONSABLE_INSCRIPTO','MONOTRIBUTO','EXENTO')),
  inicio_actividades date,

  -- Certificado digital de AFIP. Ambos CIFRADOS con AES-256-GCM (ARCA_ENCRYPTION_KEY).
  arca_key_enc      text,   -- clave privada RSA (la generamos nosotros, nunca sale del server)
  arca_cert_enc     text,   -- el .crt que devuelve AFIP
  cert_vence_at     timestamptz,
  cert_alias        text,

  habilitada        boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_config_singleton CHECK (id = true)
);

-- La clave privada y el certificado NO se exponen nunca al navegador. Por eso
-- `authenticated` no tiene SELECT sobre la tabla: se lee sólo desde funciones
-- del servidor con la service_role key.
GRANT ALL ON public.fiscal_config TO service_role;
ALTER TABLE public.fiscal_config ENABLE ROW LEVEL SECURITY;
-- Sin policies para `authenticated` => RLS niega todo. Intencional.

INSERT INTO public.fiscal_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

CREATE TRIGGER trg_fiscal_config_upd BEFORE UPDATE ON public.fiscal_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Vista segura: lo que la UI SÍ puede ver (nunca el cert ni la clave).
CREATE OR REPLACE VIEW public.fiscal_config_publica
WITH (security_invoker = true) AS
SELECT
  cuit, razon_social, nombre_fantasia, domicilio_fiscal, condicion_iva,
  inicio_actividades, habilitada, cert_vence_at, cert_alias,
  (arca_key_enc  IS NOT NULL) AS tiene_clave,
  (arca_cert_enc IS NOT NULL) AS tiene_certificado
FROM public.fiscal_config;
GRANT SELECT ON public.fiscal_config_publica TO authenticated;


-- ------------------------------------------------------------
-- 3. Puntos de venta (uno por sucursal)
-- ------------------------------------------------------------
-- AFIP numera por (punto de venta, tipo de comprobante). Cada sucursal necesita
-- su propio PV dado de alta en AFIP como "Web Services - WSFE".
CREATE TABLE IF NOT EXISTS public.puntos_venta (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id  uuid NOT NULL UNIQUE REFERENCES public.sucursales(id) ON DELETE CASCADE,
  numero       integer NOT NULL,
  -- El modo es POR punto de venta, no una variable de entorno global: se puede
  -- tener una sucursal ya en producción mientras la otra sigue probando.
  modo         text NOT NULL DEFAULT 'HOMOLOGACION'
               CHECK (modo IN ('HOMOLOGACION','PRODUCCION')),
  activo       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (numero, modo)
);
GRANT SELECT ON public.puntos_venta TO authenticated;
GRANT ALL ON public.puntos_venta TO service_role;
ALTER TABLE public.puntos_venta ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pv select" ON public.puntos_venta FOR SELECT TO authenticated USING (true);
-- Escritura sólo desde el servidor (service_role): tocar el PV o el modo cambia
-- si las facturas son legalmente válidas o no.

CREATE TRIGGER trg_pv_upd BEFORE UPDATE ON public.puntos_venta
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ------------------------------------------------------------
-- 4. Datos fiscales en las ventas
-- ------------------------------------------------------------
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS cae                text,
  ADD COLUMN IF NOT EXISTS cae_vencimiento    date,
  -- NO_APLICA: documento interno (remito, factura interna) que no va a AFIP.
  ADD COLUMN IF NOT EXISTS afip_estado        text NOT NULL DEFAULT 'NO_APLICA'
    CHECK (afip_estado IN ('NO_APLICA','PENDIENTE','APROBADO','ERROR')),
  ADD COLUMN IF NOT EXISTS afip_error         text,
  ADD COLUMN IF NOT EXISTS afip_cbte_tipo     integer,   -- 1=FacA 6=FacB 11=FacC 3/8/13=NC 2/7/12=ND
  ADD COLUMN IF NOT EXISTS afip_punto_venta   integer,
  ADD COLUMN IF NOT EXISTS afip_numero        integer,   -- lo asigna AFIP, no nosotros
  ADD COLUMN IF NOT EXISTS afip_modo          text CHECK (afip_modo IN ('HOMOLOGACION','PRODUCCION')),
  ADD COLUMN IF NOT EXISTS afip_emitido_at    timestamptz,
  ADD COLUMN IF NOT EXISTS afip_intentos      integer NOT NULL DEFAULT 0,
  -- Para notas de crédito/débito: el comprobante que rectifican (CbtesAsoc).
  ADD COLUMN IF NOT EXISTS afip_cbte_asoc_id  uuid REFERENCES public.ventas(id);

COMMENT ON COLUMN public.ventas.afip_numero IS
  'Número fiscal asignado por AFIP. Distinto de numero_comprobante, que es la numeración interna del mostrador.';

-- LA restricción que impide duplicar numeración fiscal. Si el sistema intentara
-- emitir dos veces el mismo (PV, tipo, número), la base lo rechaza.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_afip_numeracion
  ON public.ventas (afip_punto_venta, afip_cbte_tipo, afip_numero, afip_modo)
  WHERE afip_numero IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_afip_pendientes
  ON public.ventas (afip_estado, fecha DESC)
  WHERE afip_estado IN ('PENDIENTE','ERROR');


-- ------------------------------------------------------------
-- 5. Caché del ticket de acceso de AFIP (WSAA)
-- ------------------------------------------------------------
-- El TA dura 12h. AFIP rechaza pedir uno nuevo si todavía hay uno válido, y
-- limita los intentos de login. En serverless no hay memoria compartida entre
-- invocaciones, así que el TA tiene que vivir acá.
--
-- El contenido son credenciales bearer de 12h contra AFIP => se guarda CIFRADO
-- y la tabla no es accesible desde el navegador bajo ninguna circunstancia.
CREATE TABLE IF NOT EXISTS public.afip_ta (
  cuit         text    NOT NULL,
  service_name text    NOT NULL,   -- 'wsfe'
  production   boolean NOT NULL,
  ticket_enc   text    NOT NULL,
  expires_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cuit, service_name, production)
);
GRANT ALL ON public.afip_ta TO service_role;
ALTER TABLE public.afip_ta ENABLE ROW LEVEL SECURITY;
-- Sin policies. `authenticated` no lo toca ni para leer.


-- ------------------------------------------------------------
-- 6. Seed de puntos de venta
-- ------------------------------------------------------------
-- Arrancan en HOMOLOGACIÓN. Se pasan a PRODUCCION desde el panel, y sólo
-- después de que AFIP habilite el PV para producción.
INSERT INTO public.puntos_venta (sucursal_id, numero, modo)
SELECT id, CASE codigo WHEN 'OHIGGINS' THEN 1 ELSE 2 END, 'HOMOLOGACION'
  FROM public.sucursales
ON CONFLICT (sucursal_id) DO NOTHING;
