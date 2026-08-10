-- ============================================================
-- Lo que le falta a la base para poder imprimir un comprobante fiscal en serio.
--
-- Dos cosas:
--
--   1. INGRESOS BRUTOS del emisor. Es un dato obligatorio en el encabezado de un
--      comprobante y no existía en ningún lado. Sin esto no se puede imprimir.
--
--   2. UN SNAPSHOT de los datos fiscales al momento de emitir. Hoy el PDF y el QR
--      releen `clientes` y `fiscal_config` en vivo, así que un comprobante ya
--      autorizado CAMBIA si después se corrige la ficha del cliente o los datos
--      del emisor. Eso rompe dos cosas:
--        · el QR pasa a declarar un receptor distinto del que tiene AFIP;
--        · una reimpresión no coincide con el original entregado al cliente.
--      Un comprobante fiscal es inmutable. Lo que se le declaró a AFIP se congela
--      acá y de ahí en más se imprime SIEMPRE desde esta copia.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Ingresos Brutos del emisor
-- ------------------------------------------------------------
ALTER TABLE public.fiscal_config
  ADD COLUMN IF NOT EXISTS ingresos_brutos text;

COMMENT ON COLUMN public.fiscal_config.ingresos_brutos IS
  'N° de Ingresos Brutos (o "Exento" / "Convenio Multilateral NNN"). Va impreso en '
  'el encabezado del comprobante. Lo tiene que dar el contador.';

-- La vista pública lo expone: no es secreto, se imprime en cada factura.
-- Va DROP + CREATE y no CREATE OR REPLACE: reemplazar una vista sólo permite
-- agregar columnas al final, y acá ingresos_brutos entra en el medio (al lado de
-- inicio_actividades, que es donde corresponde leerlo).
DROP VIEW IF EXISTS public.fiscal_config_publica;
CREATE VIEW public.fiscal_config_publica
WITH (security_invoker = true) AS
SELECT
  cuit, razon_social, nombre_fantasia, domicilio_fiscal, condicion_iva,
  inicio_actividades, ingresos_brutos, habilitada, cert_vence_at, cert_alias,
  (arca_key_enc  IS NOT NULL) AS tiene_clave,
  (arca_cert_enc IS NOT NULL) AS tiene_certificado
FROM public.fiscal_config;
GRANT SELECT ON public.fiscal_config_publica TO authenticated;


-- ------------------------------------------------------------
-- 2. Snapshot fiscal del comprobante
-- ------------------------------------------------------------
-- Se escribe UNA vez, junto con el CAE, y no se toca nunca más. Guarda emisor,
-- receptor (con la condición de IVA REALMENTE declarada a AFIP, que puede diferir
-- de la ficha del cliente cuando se fuerza Consumidor Final) y los totales
-- exactos que se enviaron, con el desglose por alícuota.
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS afip_snapshot jsonb;

COMMENT ON COLUMN public.ventas.afip_snapshot IS
  'Copia congelada de los datos fiscales tal como se declararon a AFIP (emisor, '
  'receptor, totales y alícuotas). Es la fuente de verdad para imprimir y reimprimir '
  'el comprobante: no se relee de clientes ni de fiscal_config, que cambian.';


-- ------------------------------------------------------------
-- 3. Que el snapshot sea inmutable desde el navegador
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_ventas_columnas()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    IF NEW.cae               IS DISTINCT FROM OLD.cae
       OR NEW.cae_vencimiento IS DISTINCT FROM OLD.cae_vencimiento
       OR NEW.afip_estado     IS DISTINCT FROM OLD.afip_estado
       OR NEW.afip_numero     IS DISTINCT FROM OLD.afip_numero
       OR NEW.afip_cbte_tipo  IS DISTINCT FROM OLD.afip_cbte_tipo
       OR NEW.afip_punto_venta IS DISTINCT FROM OLD.afip_punto_venta
       OR NEW.afip_modo       IS DISTINCT FROM OLD.afip_modo
       OR NEW.afip_simulado   IS DISTINCT FROM OLD.afip_simulado
       OR NEW.afip_snapshot   IS DISTINCT FROM OLD.afip_snapshot
       OR NEW.total           IS DISTINCT FROM OLD.total
       OR NEW.total_pagado    IS DISTINCT FROM OLD.total_pagado
       OR NEW.estado          IS DISTINCT FROM OLD.estado
       OR NEW.estado_pago     IS DISTINCT FROM OLD.estado_pago
       OR NEW.subtotal_sin_iva IS DISTINCT FROM OLD.subtotal_sin_iva
       OR NEW.iva_total       IS DISTINCT FROM OLD.iva_total
       OR NEW.numero_comprobante IS DISTINCT FROM OLD.numero_comprobante
       OR NEW.tipo_comprobante IS DISTINCT FROM OLD.tipo_comprobante THEN
      RAISE EXCEPTION 'Esos campos de la venta no se editan directamente (facturación y montos van por el sistema)';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
