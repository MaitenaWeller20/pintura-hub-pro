CREATE TYPE public.modalidad_nc_periodo AS ENUM (
  'DEVOLUCION_PRODUCTOS',
  'BONIFICACION_AJUSTE'
);

CREATE TYPE public.resolucion_nc_periodo AS ENUM (
  'REINTEGRO',
  'SALDO_FAVOR'
);

ALTER TABLE public.settings
  ADD COLUMN nota_credito_periodo_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN puede_emitir_nc_periodo boolean NOT NULL DEFAULT false;

ALTER TABLE public.ventas
  ADD COLUMN nc_periodo_modalidad public.modalidad_nc_periodo,
  ADD COLUMN periodo_asoc_desde date,
  ADD COLUMN periodo_asoc_hasta date,
  ADD COLUMN motivo_nota_credito text,
  ADD COLUMN nc_resolucion public.resolucion_nc_periodo,
  ADD COLUMN nc_periodo_payload_hash text,
  ADD COLUMN nc_efectos_aplicados_at timestamptz,
  ADD CONSTRAINT ventas_nc_periodo_completitud_check CHECK (
    (
      nc_periodo_modalidad IS NULL
      AND periodo_asoc_desde IS NULL
      AND periodo_asoc_hasta IS NULL
      AND motivo_nota_credito IS NULL
      AND nc_resolucion IS NULL
      AND nc_periodo_payload_hash IS NULL
      AND nc_efectos_aplicados_at IS NULL
    )
    OR (
      tipo_comprobante='NOTA_CREDITO'
      AND afip_cbte_asoc_id IS NULL
      AND nc_periodo_modalidad IS NOT NULL
      AND periodo_asoc_desde IS NOT NULL
      AND periodo_asoc_hasta IS NOT NULL
      AND periodo_asoc_desde <= periodo_asoc_hasta
      AND length(btrim(motivo_nota_credito)) >= 5
      AND nc_resolucion IS NOT NULL
      AND nc_periodo_payload_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT ventas_nc_asociacion_exclusiva_check CHECK (
    afip_cbte_asoc_id IS NULL
    OR (
      periodo_asoc_desde IS NULL
      AND periodo_asoc_hasta IS NULL
      AND nc_periodo_modalidad IS NULL
      AND nc_resolucion IS NULL
    )
  ),
  ADD CONSTRAINT ventas_nc_periodo_efectos_check CHECK (
    nc_efectos_aplicados_at IS NULL
    OR (nc_periodo_modalidad IS NOT NULL AND estado='ACTIVA')
  );

CREATE TABLE public.nota_credito_periodo_reintegros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id uuid NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  forma_pago public.forma_pago NOT NULL CHECK (forma_pago <> 'CTA_CTE'),
  monto numeric(14,2) NOT NULL CHECK (monto > 0),
  detalle jsonb NOT NULL DEFAULT '{}'::jsonb,
  orden integer NOT NULL CHECK (orden >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venta_id,orden)
);

ALTER TABLE public.nota_credito_periodo_reintegros ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nota_credito_periodo_reintegros
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.nota_credito_periodo_reintegros
  TO authenticated,service_role;
GRANT ALL ON public.nota_credito_periodo_reintegros TO service_role;

CREATE POLICY nota_credito_periodo_reintegros_select
  ON public.nota_credito_periodo_reintegros
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.ventas AS v
       WHERE v.id=nota_credito_periodo_reintegros.venta_id
         AND (
           public.is_admin(auth.uid())
           OR v.sucursal_id=public.current_sucursal_id()
         )
    )
  );

CREATE OR REPLACE FUNCTION public.puede_emitir_nc_periodo(
  _uid uuid DEFAULT auth.uid()
) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $$
  SELECT public.is_admin(_uid)
      OR COALESCE((
        SELECT p.activo AND p.puede_facturar AND p.puede_emitir_nc_periodo
          FROM public.profiles AS p
         WHERE p.id=_uid
      ),false);
$$;

REVOKE ALL ON FUNCTION public.puede_emitir_nc_periodo(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.puede_emitir_nc_periodo(uuid)
  TO authenticated,service_role;

-- Copia completa del guard vigente: se agrega la nueva capacidad fiscal sin
-- retirar ninguna de las protecciones de sucursal, actividad o secciones.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF NEW.puede_facturar IS DISTINCT FROM OLD.puede_facturar
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'No puede modificar el permiso fiscal de su propio perfil';
  END IF;

  IF NEW.puede_emitir_nc_periodo IS DISTINCT FROM OLD.puede_emitir_nc_periodo
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'No puede modificar el permiso de NC por período de su propio perfil';
  END IF;

  IF NEW.puede_gestionar_credito_clientes
       IS DISTINCT FROM OLD.puede_gestionar_credito_clientes
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'Sólo un administrador autenticado puede cambiar el permiso de cuenta corriente';
  END IF;

  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    IF NEW.sucursal_id IS NULL THEN
      RAISE EXCEPTION 'No te podés quedar sin sucursal: elegí en cuál estás trabajando';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.profile_sucursales AS ps
       WHERE ps.profile_id=NEW.id
         AND ps.sucursal_id=NEW.sucursal_id
    ) THEN
      RAISE EXCEPTION 'No trabajás en esa sucursal. Pedile a un administrador que te habilite.';
    END IF;
  END IF;

  IF NEW.activo IS DISTINCT FROM OLD.activo THEN
    RAISE EXCEPTION 'Sólo un administrador puede activar o desactivar un usuario';
  END IF;
  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'El nombre de usuario no se puede cambiar';
  END IF;
  IF NEW.permite_venta_sin_stock IS DISTINCT FROM OLD.permite_venta_sin_stock THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar el permiso de venta sin stock';
  END IF;
  IF NEW.secciones IS DISTINCT FROM OLD.secciones THEN
    RAISE EXCEPTION 'Sólo un administrador puede cambiar las secciones de un usuario';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profiles_columnas()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.administrar_puede_emitir_nc_periodo(
  p_profile_id uuid,
  p_habilitado boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador autenticado puede cambiar el permiso de NC por período'
      USING ERRCODE='42501';
  END IF;

  PERFORM 1
    FROM public.profiles AS p
   WHERE p.id=p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente';
  END IF;

  UPDATE public.profiles
     SET puede_emitir_nc_periodo=p_habilitado
   WHERE id=p_profile_id;
END;
$$;

REVOKE ALL ON FUNCTION public.administrar_puede_emitir_nc_periodo(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.administrar_puede_emitir_nc_periodo(uuid,boolean)
  TO authenticated,service_role;

-- Copia completa del guard fiscal vigente más los siete campos nuevos. El
-- guard enfocado que sigue impide además cualquier mutación directa de la fila.
CREATE OR REPLACE FUNCTION public.guard_ventas_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
BEGIN
  IF current_user='authenticated' THEN
    IF NEW.cae IS DISTINCT FROM OLD.cae
       OR NEW.cae_vencimiento IS DISTINCT FROM OLD.cae_vencimiento
       OR NEW.afip_estado IS DISTINCT FROM OLD.afip_estado
       OR NEW.afip_error IS DISTINCT FROM OLD.afip_error
       OR NEW.afip_cbte_tipo IS DISTINCT FROM OLD.afip_cbte_tipo
       OR NEW.afip_punto_venta IS DISTINCT FROM OLD.afip_punto_venta
       OR NEW.afip_numero IS DISTINCT FROM OLD.afip_numero
       OR NEW.afip_modo IS DISTINCT FROM OLD.afip_modo
       OR NEW.afip_emitido_at IS DISTINCT FROM OLD.afip_emitido_at
       OR NEW.afip_intentos IS DISTINCT FROM OLD.afip_intentos
       OR NEW.afip_cbte_asoc_id IS DISTINCT FROM OLD.afip_cbte_asoc_id
       OR NEW.afip_imp_total IS DISTINCT FROM OLD.afip_imp_total
       OR NEW.afip_simulado IS DISTINCT FROM OLD.afip_simulado
       OR NEW.afip_snapshot IS DISTINCT FROM OLD.afip_snapshot
       OR NEW.afip_emisor_cuit IS DISTINCT FROM OLD.afip_emisor_cuit
       OR NEW.afip_fecha_comprobante IS DISTINCT FROM OLD.afip_fecha_comprobante
       OR NEW.afip_snapshot_hash IS DISTINCT FROM OLD.afip_snapshot_hash
       OR NEW.afip_claim_token IS DISTINCT FROM OLD.afip_claim_token
       OR NEW.afip_claimed_at IS DISTINCT FROM OLD.afip_claimed_at
       OR NEW.afip_fase IS DISTINCT FROM OLD.afip_fase
       OR NEW.afip_error_clase IS DISTINCT FROM OLD.afip_error_clase
       OR NEW.afip_error_codigo IS DISTINCT FROM OLD.afip_error_codigo
       OR NEW.afip_error_fase IS DISTINCT FROM OLD.afip_error_fase
       OR NEW.afip_ultimo_error_at IS DISTINCT FROM OLD.afip_ultimo_error_at
       OR NEW.afip_validez IS DISTINCT FROM OLD.afip_validez
       OR NEW.afip_legacy_incompleto IS DISTINCT FROM OLD.afip_legacy_incompleto
       OR NEW.afip_version IS DISTINCT FROM OLD.afip_version
       OR NEW.nc_periodo_modalidad IS DISTINCT FROM OLD.nc_periodo_modalidad
       OR NEW.periodo_asoc_desde IS DISTINCT FROM OLD.periodo_asoc_desde
       OR NEW.periodo_asoc_hasta IS DISTINCT FROM OLD.periodo_asoc_hasta
       OR NEW.motivo_nota_credito IS DISTINCT FROM OLD.motivo_nota_credito
       OR NEW.nc_resolucion IS DISTINCT FROM OLD.nc_resolucion
       OR NEW.nc_periodo_payload_hash IS DISTINCT FROM OLD.nc_periodo_payload_hash
       OR NEW.nc_efectos_aplicados_at IS DISTINCT FROM OLD.nc_efectos_aplicados_at
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.total_pagado IS DISTINCT FROM OLD.total_pagado
       OR NEW.estado IS DISTINCT FROM OLD.estado
       OR NEW.estado_pago IS DISTINCT FROM OLD.estado_pago
       OR NEW.subtotal_sin_iva IS DISTINCT FROM OLD.subtotal_sin_iva
       OR NEW.iva_total IS DISTINCT FROM OLD.iva_total
       OR NEW.numero_comprobante IS DISTINCT FROM OLD.numero_comprobante
       OR NEW.tipo_comprobante IS DISTINCT FROM OLD.tipo_comprobante THEN
      RAISE EXCEPTION 'Esos campos de la venta no se editan directamente (facturación y montos van por el sistema)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ventas_columnas()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.guard_ventas_nc_periodo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_owner name;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO v_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid=TG_RELID;

  IF current_user=v_owner THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.nc_periodo_modalidad IS NOT NULL
       OR NEW.nc_efectos_aplicados_at IS NOT NULL THEN
      RAISE EXCEPTION 'Las notas de crédito por período sólo se escriben mediante funciones del sistema'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' THEN
    IF OLD.nc_periodo_modalidad IS NOT NULL
       OR NEW.nc_periodo_modalidad IS NOT NULL
       OR OLD.afip_estado='APROBADO'
       OR OLD.nc_efectos_aplicados_at IS NOT NULL THEN
      RAISE EXCEPTION 'La nota de crédito por período o venta aprobada es inmutable fuera de la transición fiscal'
        USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.nc_periodo_modalidad IS NOT NULL
     OR OLD.afip_estado='APROBADO'
     OR OLD.nc_efectos_aplicados_at IS NOT NULL THEN
    RAISE EXCEPTION 'La nota de crédito por período o venta aprobada no se elimina directamente'
      USING ERRCODE='42501';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_ventas_nc_periodo()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER trg_guard_ventas_nc_periodo
  BEFORE INSERT OR UPDATE OR DELETE ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.guard_ventas_nc_periodo();

CREATE OR REPLACE FUNCTION public.guard_venta_hijos_nc_periodo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_owner name;
  v_venta_ids uuid[];
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner)
    INTO v_owner
    FROM pg_catalog.pg_class AS c
   WHERE c.oid=TG_RELID;

  IF current_user=v_owner THEN
    IF TG_OP='DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='INSERT' THEN
    v_venta_ids := ARRAY[NEW.venta_id];
  ELSIF TG_OP='DELETE' THEN
    v_venta_ids := ARRAY[OLD.venta_id];
  ELSE
    v_venta_ids := ARRAY[OLD.venta_id,NEW.venta_id];
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.ventas AS v
     WHERE v.id=ANY(v_venta_ids)
       AND (
         v.nc_periodo_modalidad IS NOT NULL
         OR v.afip_estado='APROBADO'
         OR v.nc_efectos_aplicados_at IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'Los ítems y pagos de una nota de crédito por período o venta aprobada son inmutables fuera de funciones del sistema'
      USING ERRCODE='42501';
  END IF;

  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_venta_hijos_nc_periodo()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER trg_guard_venta_items_nc_periodo
  BEFORE INSERT OR UPDATE OR DELETE ON public.venta_items
  FOR EACH ROW EXECUTE FUNCTION public.guard_venta_hijos_nc_periodo();

CREATE TRIGGER trg_guard_venta_pagos_nc_periodo
  BEFORE INSERT OR UPDATE OR DELETE ON public.venta_pagos
  FOR EACH ROW EXECUTE FUNCTION public.guard_venta_hijos_nc_periodo();

-- El backfill es una operación de mantenimiento service_role-only que también
-- normaliza evidencia de filas cuyo OLD ya está APROBADO. Ejecutarlo con el
-- dueño de tabla conserva ese flujo sin convertir service_role directo en un
-- escritor post-CAE.
ALTER FUNCTION public.backfill_cola_fiscal(boolean) SECURITY DEFINER;
