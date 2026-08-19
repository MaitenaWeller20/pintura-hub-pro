-- ============================================================
-- Facturación electrónica con un contexto fiscal por emisor.
--
-- General Paz y O'Higgins pertenecen a personas jurídicas distintas. Cada
-- CUIT necesita su propia clave/certificado, su PV y su espacio de numeración.
-- La configuración singleton queda intacta como fuente de rollback, pero la
-- aplicación deja de usarla después de esta migración.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Identidad fiscal completa de cada persona jurídica
-- ------------------------------------------------------------
ALTER TABLE public.emisores
  ADD COLUMN IF NOT EXISTS nombre_fantasia text;

UPDATE public.emisores SET
  razon_social='APLICACIONES Y SERVICIOS S.R.L.',
  nombre_fantasia='CasaForma',
  cuit='30714199664',
  domicilio_fiscal='SARMIENTO 1398 - B° GENERAL PAZ NORTE - CÓRDOBA (CP 5000)',
  condicion_iva='RESPONSABLE_INSCRIPTO',
  ingresos_brutos='280970280',
  -- No se deduce de la constancia de IIBB: queda pendiente de confirmación.
  inicio_actividades=NULL
WHERE upper(replace(razon_social,'.',''))='APLICACIONES Y SERVICIOS SRL';

UPDATE public.emisores SET
  razon_social='GRUPO CASA FORMA S.A.S.',
  nombre_fantasia='CasaForma',
  cuit='30717322467',
  domicilio_fiscal='BERNARDO O''HIGGINS 5450 DPTO E2 - VILLA EUCARÍSTICA - CÓRDOBA (CP 5014)',
  condicion_iva='RESPONSABLE_INSCRIPTO',
  ingresos_brutos='286447821',
  inicio_actividades=NULL
WHERE upper(replace(razon_social,'.',''))='GRUPO CASA FORMA SAS';

CREATE UNIQUE INDEX IF NOT EXISTS uq_emisores_cuit
  ON public.emisores(cuit) WHERE cuit IS NOT NULL;


-- ------------------------------------------------------------
-- 2. Clave y certificado por emisor y ambiente
-- ------------------------------------------------------------
CREATE TABLE public.credenciales_arca (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emisor_id uuid NOT NULL REFERENCES public.emisores(id) ON DELETE RESTRICT,
  ambiente text NOT NULL CHECK (ambiente IN ('HOMOLOGACION','PRODUCCION')),
  arca_key_enc text,
  arca_cert_enc text,
  cert_vence_at timestamptz,
  cert_alias text,
  -- Se completa sólo después de una llamada real exitosa a WSFE. En mock no.
  probada_at timestamptz,
  habilitada boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_credenciales_arca_emisor_ambiente UNIQUE (emisor_id,ambiente)
);

CREATE TRIGGER trg_credenciales_arca_upd
  BEFORE UPDATE ON public.credenciales_arca
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- La Data API necesita grants explícitos desde 2026. Sólo el cliente de
-- servidor puede tocar esta tabla; no se crean policies de navegador.
ALTER TABLE public.credenciales_arca ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credenciales_arca FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.credenciales_arca TO service_role;

-- La clave ya usada para generar el CSR de Aplicaciones se copia tal cual. La
-- fila nace deshabilitada hasta que se cargue y verifique el certificado.
INSERT INTO public.credenciales_arca (
  emisor_id,ambiente,arca_key_enc,arca_cert_enc,cert_vence_at,cert_alias,habilitada
)
SELECT
  e.id,'PRODUCCION',f.arca_key_enc,f.arca_cert_enc,
  f.cert_vence_at,f.cert_alias,false
FROM public.fiscal_config f
JOIN public.emisores e
  ON e.cuit=regexp_replace(coalesce(f.cuit,''),'\D','','g')
WHERE f.id=true
  AND (f.arca_key_enc IS NOT NULL OR f.arca_cert_enc IS NOT NULL)
ON CONFLICT (emisor_id,ambiente) DO NOTHING;


-- ------------------------------------------------------------
-- 3. El PV pertenece tanto a la sucursal como a su emisor
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sucursales WHERE emisor_id IS NULL) THEN
    RAISE EXCEPTION 'Hay sucursales sin emisor; corregirlas antes de migrar facturación';
  END IF;
END $$;

ALTER TABLE public.sucursales ALTER COLUMN emisor_id SET NOT NULL;
ALTER TABLE public.sucursales
  ADD CONSTRAINT uq_sucursales_id_emisor UNIQUE (id,emisor_id);

ALTER TABLE public.puntos_venta ADD COLUMN emisor_id uuid;
UPDATE public.puntos_venta p SET emisor_id=s.emisor_id
FROM public.sucursales s
WHERE s.id=p.sucursal_id;
ALTER TABLE public.puntos_venta ALTER COLUMN emisor_id SET NOT NULL;

ALTER TABLE public.puntos_venta
  DROP CONSTRAINT IF EXISTS puntos_venta_numero_modo_key;
ALTER TABLE public.puntos_venta
  ADD CONSTRAINT fk_puntos_venta_sucursal_emisor
  FOREIGN KEY (sucursal_id,emisor_id)
  REFERENCES public.sucursales(id,emisor_id);
ALTER TABLE public.puntos_venta
  ADD CONSTRAINT uq_puntos_venta_emisor_numero_modo
  UNIQUE (emisor_id,numero,modo);

-- No se habilita O'Higgins con datos supuestos. Su CSR, certificado y PV
-- productivo deben tramitarse para el CUIT de Grupo Casa Forma.
UPDATE public.puntos_venta p SET activo=false, modo='HOMOLOGACION'
FROM public.sucursales s
WHERE s.id=p.sucursal_id AND s.codigo::text='OHIGGINS';


-- ------------------------------------------------------------
-- 4. El CUIT forma parte de la identidad del número fiscal
-- ------------------------------------------------------------
ALTER TABLE public.ventas ADD COLUMN afip_emisor_cuit text;

UPDATE public.ventas v SET afip_emisor_cuit=coalesce(
  nullif(regexp_replace(v.afip_snapshot->'emisor'->>'cuit','\D','','g'),''),
  (SELECT regexp_replace(cuit,'\D','','g') FROM public.fiscal_config WHERE id=true)
)
WHERE v.afip_numero IS NOT NULL;

ALTER TABLE public.ventas
  ADD CONSTRAINT ck_ventas_afip_emisor_cuit
  CHECK (
    afip_numero IS NULL
    OR (afip_emisor_cuit IS NOT NULL AND afip_emisor_cuit ~ '^[0-9]{11}$')
  );

DROP INDEX IF EXISTS public.uq_ventas_afip_numeracion;
CREATE UNIQUE INDEX uq_ventas_afip_numeracion
  ON public.ventas (
    afip_emisor_cuit,afip_punto_venta,afip_cbte_tipo,
    afip_numero,afip_modo,afip_simulado
  )
  WHERE afip_numero IS NOT NULL;

-- El navegador puede crear ventas sin número fiscal, pero nunca adjudicar ni
-- cambiar el CUIT que legalmente las emitió.
CREATE OR REPLACE FUNCTION public.guard_ventas_afip_emisor_cuit()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF current_user='authenticated' AND (
    (TG_OP='INSERT' AND NEW.afip_emisor_cuit IS NOT NULL)
    OR (TG_OP='UPDATE' AND NEW.afip_emisor_cuit IS DISTINCT FROM OLD.afip_emisor_cuit)
  ) THEN
    RAISE EXCEPTION 'El CUIT emisor fiscal sólo lo asigna el servidor';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_ventas_afip_emisor_cuit
  BEFORE INSERT OR UPDATE ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.guard_ventas_afip_emisor_cuit();
