-- ============================================================
-- Capa aditiva para receptor fiscal y cola durable.
--
-- Esta migración no cambia los escritores existentes ni ejecuta el backfill.
-- Durante la convivencia siguen siendo válidos PENDIENTE/ERROR y los flags
-- nacen con v2 apagado + escritor legacy encendido.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Permiso fiscal, evidencia de Factura A y flags de rollout
-- ------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN puede_facturar boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.puede_facturar IS
  'Capacidad fiscal explícita para empleados. Los admins la tienen efectivamente '
  'por rol; este campo sólo lo modifica el canal administrativo del servidor.';

ALTER TABLE public.emisores
  ADD COLUMN factura_a_modalidad text NOT NULL DEFAULT 'DESCONOCIDA',
  ADD COLUMN factura_a_confirmada_at timestamptz,
  ADD COLUMN factura_a_confirmada_por uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN factura_a_revalidar_at date,
  ADD COLUMN factura_a_evidencia text;

ALTER TABLE public.emisores
  ADD CONSTRAINT ck_emisores_factura_a_modalidad
  CHECK (factura_a_modalidad IN (
    'DESCONOCIDA','ESTANDAR_CONFIRMADA','NO_SOPORTADA'
  ));

ALTER TABLE public.settings
  ADD COLUMN facturacion_receptor_v2_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN facturacion_legacy_writer_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.settings
  ADD CONSTRAINT ck_settings_escritor_fiscal_exclusivo
  CHECK (NOT (
    facturacion_receptor_v2_enabled
    AND facturacion_legacy_writer_enabled
  ));

COMMENT ON COLUMN public.settings.facturacion_receptor_v2_enabled IS
  'Habilita el flujo neutral/receptor v2. Nace apagado para un deploy aditivo.';
COMMENT ON COLUMN public.settings.facturacion_legacy_writer_enabled IS
  'Habilita el escritor fiscal legacy durante coexistencia. Ambos escritores no pueden estar activos a la vez.';

-- ------------------------------------------------------------
-- 2. Estado fiscal embebido en ventas
-- ------------------------------------------------------------
ALTER TABLE public.ventas
  ADD COLUMN afip_fecha_comprobante date,
  ADD COLUMN afip_snapshot_hash text,
  ADD COLUMN afip_claim_token uuid,
  ADD COLUMN afip_claimed_at timestamptz,
  ADD COLUMN afip_fase text,
  ADD COLUMN afip_error_clase text,
  ADD COLUMN afip_error_codigo text,
  ADD COLUMN afip_error_fase text,
  ADD COLUMN afip_ultimo_error_at timestamptz,
  ADD COLUMN afip_validez text,
  ADD COLUMN afip_legacy_incompleto boolean NOT NULL DEFAULT false,
  ADD COLUMN afip_version integer NOT NULL DEFAULT 0;

ALTER TABLE public.ventas
  DROP CONSTRAINT ventas_afip_estado_check;

ALTER TABLE public.ventas
  ADD CONSTRAINT ck_ventas_afip_estado
  CHECK (afip_estado IN (
    'NO_APLICA','PENDIENTE','ERROR',
    'SIN_FACTURAR','EMITIENDO','APROBADO','ERROR_CORREGIBLE',
    'RECONCILIAR','CANCELADO','BLOQUEADO'
  )),
  ADD CONSTRAINT ck_ventas_afip_fase
  CHECK (
    afip_fase IS NULL OR afip_fase IN (
      'PREFLIGHT','RESERVADO','REQUEST_INICIADO','RESPUESTA_RECIBIDA','PERSISTIDO'
    )
  ),
  ADD CONSTRAINT ck_ventas_afip_validez
  CHECK (
    afip_validez IS NULL OR afip_validez IN (
      'PRODUCCION','HOMOLOGACION','SIMULADA'
    )
  ),
  ADD CONSTRAINT ck_ventas_afip_version
  CHECK (afip_version >= 0),
  ADD CONSTRAINT ck_ventas_afip_claim_coherente
  CHECK (
    (afip_claim_token IS NULL) = (afip_claimed_at IS NULL)
  ),
  ADD CONSTRAINT ck_ventas_afip_validez_coherente
  CHECK (
    afip_validez IS NULL
    OR (afip_validez='SIMULADA' AND afip_simulado)
    OR (afip_validez='HOMOLOGACION' AND NOT afip_simulado AND afip_modo='HOMOLOGACION')
    OR (afip_validez='PRODUCCION' AND NOT afip_simulado AND afip_modo='PRODUCCION')
  ),
  ADD CONSTRAINT ck_ventas_afip_snapshot_coherente
  CHECK (
    (afip_snapshot_hash IS NULL OR (
      afip_snapshot IS NOT NULL
      AND afip_version >= 2
      AND afip_snapshot->>'version'='2'
    ))
    AND (
      afip_numero IS NULL
      OR afip_version=0
      OR (
        afip_snapshot IS NOT NULL
        AND afip_snapshot_hash IS NOT NULL
        AND afip_version >= 2
        AND afip_snapshot->>'version'='2'
      )
      OR (afip_estado='BLOQUEADO' AND afip_legacy_incompleto)
    )
  ),
  ADD CONSTRAINT ck_ventas_afip_estado_integridad
  CHECK (
    (
      afip_estado <> 'APROBADO'
      OR (
        cae IS NOT NULL
        AND afip_numero IS NOT NULL
        AND (
          afip_version=0
          OR afip_legacy_incompleto
          OR (
            afip_version >= 2
            AND afip_snapshot IS NOT NULL
            AND afip_snapshot->>'version'='2'
            AND afip_snapshot_hash IS NOT NULL
            AND afip_fecha_comprobante IS NOT NULL
            AND afip_validez IS NOT NULL
          )
        )
      )
    )
    AND (afip_estado <> 'CANCELADO' OR cae IS NULL)
    AND (
      afip_estado <> 'RECONCILIAR'
      OR (
        afip_numero IS NOT NULL
        AND afip_snapshot IS NOT NULL
        AND afip_snapshot->>'version'='2'
        AND afip_snapshot_hash IS NOT NULL
        AND afip_version >= 2
        AND NOT afip_legacy_incompleto
      )
    )
    AND (
      afip_estado <> 'EMITIENDO'
      OR (
        afip_claim_token IS NOT NULL
        AND afip_claimed_at IS NOT NULL
        AND afip_snapshot IS NOT NULL
        AND afip_snapshot->>'version'='2'
        AND afip_snapshot_hash IS NOT NULL
        AND afip_version >= 2
      )
    )
  );

COMMENT ON COLUMN public.ventas.afip_legacy_incompleto IS
  'Marca exclusiva del backfill: historial que se conserva sin reconstruir receptor, fecha, PV ni snapshot v2.';
COMMENT ON COLUMN public.ventas.afip_version IS
  'Versión optimista de la máquina fiscal. 0 identifica filas del escritor legacy durante coexistencia.';

CREATE OR REPLACE FUNCTION public.puede_facturar(_uid uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path=''
AS $$
  SELECT public.is_admin(_uid)
      OR COALESCE((
        SELECT p.activo AND p.puede_facturar
          FROM public.profiles p
         WHERE p.id=_uid
      ),false);
$$;

REVOKE ALL ON FUNCTION public.puede_facturar(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.puede_facturar(uuid)
  TO authenticated,service_role;

-- ------------------------------------------------------------
-- 3. Favoritos de receptor fiscal
-- ------------------------------------------------------------
CREATE TABLE public.receptores_fiscales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sucursal_id uuid NOT NULL REFERENCES public.sucursales(id) ON DELETE RESTRICT,
  creado_por uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  cliente_comercial_id uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
  tipo_documento text NOT NULL,
  numero_documento text NOT NULL,
  razon_social text NOT NULL,
  condicion_iva text NOT NULL,
  domicilio text,
  activo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_receptores_fiscales_tipo_documento
    CHECK (tipo_documento IN ('CUIT','CUIL','DNI','CDI')),
  CONSTRAINT ck_receptores_fiscales_documento_canonico
    CHECK (
      (tipo_documento IN ('CUIT','CUIL','CDI') AND numero_documento ~ '^[0-9]{11}$')
      OR (tipo_documento='DNI' AND numero_documento ~ '^[0-9]{7,8}$')
    ),
  CONSTRAINT ck_receptores_fiscales_razon_social
    CHECK (btrim(razon_social) <> ''),
  CONSTRAINT ck_receptores_fiscales_condicion_iva
    CHECK (condicion_iva IN (
      'RESPONSABLE_INSCRIPTO','MONOTRIBUTO','EXENTO','CONSUMIDOR_FINAL'
    ))
);

CREATE TRIGGER trg_receptores_fiscales_upd
  BEFORE UPDATE ON public.receptores_fiscales
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_receptores_fiscales_sucursal
  ON public.receptores_fiscales (sucursal_id,activo,razon_social);
CREATE INDEX idx_receptores_fiscales_documento
  ON public.receptores_fiscales (tipo_documento,numero_documento);

ALTER TABLE public.receptores_fiscales ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receptores_fiscales
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.receptores_fiscales TO authenticated;
GRANT ALL ON public.receptores_fiscales TO service_role;

-- El admin ve y administra todo. El empleado fiscal sólo ve favoritos activos
-- de su sucursal activa; no se confía en un sucursal_id enviado por el cliente.
CREATE POLICY "receptores fiscales select" ON public.receptores_fiscales
  FOR SELECT TO authenticated
  USING (
    public.is_admin((SELECT auth.uid()))
    OR (
      public.puede_facturar((SELECT auth.uid()))
      AND sucursal_id=public.current_sucursal_id()
      AND activo
    )
  );

CREATE POLICY "receptores fiscales admin insert" ON public.receptores_fiscales
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin((SELECT auth.uid())));
CREATE POLICY "receptores fiscales empleado insert" ON public.receptores_fiscales
  FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) IS NOT NULL
    AND public.puede_facturar((SELECT auth.uid()))
    AND sucursal_id=public.current_sucursal_id()
    AND creado_por=(SELECT auth.uid())
    AND tipo_documento <> 'SIN_IDENTIFICAR'
  );

CREATE POLICY "receptores fiscales admin update" ON public.receptores_fiscales
  FOR UPDATE TO authenticated
  USING (public.is_admin((SELECT auth.uid())))
  WITH CHECK (public.is_admin((SELECT auth.uid())));
CREATE POLICY "receptores fiscales empleado update" ON public.receptores_fiscales
  FOR UPDATE TO authenticated
  USING (
    public.puede_facturar((SELECT auth.uid()))
    AND sucursal_id=public.current_sucursal_id()
    AND creado_por=(SELECT auth.uid())
  )
  WITH CHECK (
    public.puede_facturar((SELECT auth.uid()))
    AND sucursal_id=public.current_sucursal_id()
    AND creado_por=(SELECT auth.uid())
    AND tipo_documento <> 'SIN_IDENTIFICAR'
  );

CREATE POLICY "receptores fiscales admin delete" ON public.receptores_fiscales
  FOR DELETE TO authenticated
  USING (public.is_admin((SELECT auth.uid())));

-- Con SELECT activo-only PostgreSQL también exige que el row nuevo de un
-- UPDATE que lee columnas satisfaga esa policy. Por eso la desactivación no se
-- expone como UPDATE general: esta RPC hace sólo activo=true->false y repite
-- explícitamente capacidad, sucursal activa y creador.
CREATE OR REPLACE FUNCTION public.desactivar_receptor_fiscal(
  p_receptor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_receptor public.receptores_fiscales%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_receptor
    FROM public.receptores_fiscales
   WHERE id=p_receptor_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Favorito fiscal inexistente o no autorizado'
      USING ERRCODE='42501';
  END IF;

  IF NOT public.is_admin(v_uid) AND NOT (
    public.puede_facturar(v_uid)
    AND v_receptor.sucursal_id=public.current_sucursal_id()
    AND v_receptor.creado_por=v_uid
  ) THEN
    RAISE EXCEPTION 'No puede desactivar este favorito fiscal'
      USING ERRCODE='42501';
  END IF;

  UPDATE public.receptores_fiscales
     SET activo=false
   WHERE id=p_receptor_id;
END;
$$;

REVOKE ALL ON FUNCTION public.desactivar_receptor_fiscal(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.desactivar_receptor_fiscal(uuid)
  TO authenticated;

-- ------------------------------------------------------------
-- 4. Auditoría interna de intentos
-- ------------------------------------------------------------
CREATE TABLE public.emision_fiscal_intentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venta_id uuid NOT NULL REFERENCES public.ventas(id) ON DELETE CASCADE,
  claim_token uuid NOT NULL,
  snapshot_version integer NOT NULL CHECK (snapshot_version >= 1),
  payload_hash text NOT NULL CHECK (btrim(payload_hash) <> ''),
  fase text NOT NULL CHECK (fase IN (
    'PREFLIGHT','RESERVADO','REQUEST_INICIADO','RESPUESTA_RECIBIDA','PERSISTIDO'
  )),
  resultado text,
  numero_reservado integer CHECK (numero_reservado IS NULL OR numero_reservado > 0),
  error_clase text,
  error_codigo text,
  respuesta_resumen jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_emision_fiscal_intentos_venta_claim
    UNIQUE (venta_id,claim_token)
);

CREATE TRIGGER trg_emision_fiscal_intentos_upd
  BEFORE UPDATE ON public.emision_fiscal_intentos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_emision_fiscal_intentos_venta
  ON public.emision_fiscal_intentos (venta_id,created_at DESC);

ALTER TABLE public.emision_fiscal_intentos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.emision_fiscal_intentos
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE ON public.emision_fiscal_intentos TO service_role;
-- Sin policies: el navegador no puede leer ni escribir la auditoría fiscal.

-- ------------------------------------------------------------
-- 5. Guard de privilegios y helper de capacidad efectiva
-- ------------------------------------------------------------
-- Copia completa de la versión vigente en 20260813120000, conservando cambio
-- de sucursal activa, activo, username, stock y secciones.
CREATE OR REPLACE FUNCTION public.guard_profiles_columnas()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  -- El permiso fiscal exige una identidad admin aun para un caller con bypass
  -- de RLS. La RPC administrativa de abajo conserva auth.uid() y satisface esta
  -- condición; service_role sin JWT no es un atajo de elevación.
  IF NEW.puede_facturar IS DISTINCT FROM OLD.puede_facturar
     AND (auth.uid() IS NULL OR NOT public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'No puede modificar el permiso fiscal de su propio perfil';
  END IF;

  IF auth.uid() IS NULL OR public.is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF NEW.sucursal_id IS DISTINCT FROM OLD.sucursal_id THEN
    IF NEW.sucursal_id IS NULL THEN
      RAISE EXCEPTION 'No te podés quedar sin sucursal: elegí en cuál estás trabajando';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.profile_sucursales
       WHERE profile_id=NEW.id AND sucursal_id=NEW.sucursal_id
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
  FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.administrar_puede_facturar(
  p_profile_id uuid,
  p_puede_facturar boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador autenticado puede cambiar el permiso fiscal'
      USING ERRCODE='42501';
  END IF;

  UPDATE public.profiles
     SET puede_facturar=p_puede_facturar
   WHERE id=p_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Perfil inexistente';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.administrar_puede_facturar(uuid,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.administrar_puede_facturar(uuid,boolean)
  TO authenticated;

-- ------------------------------------------------------------
-- 6. Backfill definido, bloqueado y no ejecutado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backfill_cola_fiscal(
  p_aplicar boolean DEFAULT false
)
RETURNS TABLE (estado_destino text,cantidad bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=''
AS $$
DECLARE
  v_grupo record;
BEGIN
  FOR v_grupo IN
    WITH clasificadas AS MATERIALIZED (
      SELECT
        v.id,
        CASE
          WHEN v.cae IS NOT NULL THEN 'APROBADO'
          WHEN v.afip_numero IS NOT NULL
               AND v.afip_version >= 2
               AND v.afip_snapshot IS NOT NULL
               AND v.afip_snapshot->>'version'='2'
               AND v.afip_snapshot_hash IS NOT NULL
            THEN 'RECONCILIAR'
          WHEN v.afip_numero IS NOT NULL THEN 'BLOQUEADO'
          WHEN v.afip_estado='ERROR'
               AND v.afip_numero IS NULL
            THEN 'ERROR_CORREGIBLE'
          WHEN v.estado='ACTIVA'
               AND v.tipo_comprobante IN ('FACTURA_A','FACTURA_B','FACTURA_C')
               AND v.afip_numero IS NULL
               AND v.cae IS NULL
            THEN 'SIN_FACTURAR'
          WHEN v.estado='ANULADA' AND v.cae IS NULL THEN 'CANCELADO'
          WHEN v.tipo_comprobante IN ('REMITO','REMITO_OBRA','FAC_INTERNA_CTA_CTE')
            THEN 'NO_APLICA'
          WHEN v.tipo_comprobante IN ('NOTA_CREDITO','NOTA_DEBITO')
               AND (
                 v.afip_cbte_asoc_id IS NULL
                 OR NOT EXISTS (
                   SELECT 1
                     FROM public.ventas original
                    WHERE original.id=v.afip_cbte_asoc_id
                      AND original.cae IS NOT NULL
                      AND original.afip_numero IS NOT NULL
                 )
               )
            THEN 'BLOQUEADO'
          ELSE NULL
        END AS destino
      FROM public.ventas v
    )
    SELECT c.destino,count(*)::bigint AS cantidad,array_agg(c.id) AS ids
      FROM clasificadas c
     WHERE c.destino IS NOT NULL
     GROUP BY c.destino
     ORDER BY c.destino
  LOOP
    IF p_aplicar THEN
      UPDATE public.ventas v
         SET afip_estado=v_grupo.destino,
             afip_validez=CASE
               WHEN v.afip_simulado THEN 'SIMULADA'
               WHEN v.afip_modo='HOMOLOGACION' THEN 'HOMOLOGACION'
               WHEN v.afip_modo='PRODUCCION' THEN 'PRODUCCION'
               ELSE v.afip_validez
             END,
             afip_legacy_incompleto=(
               v.afip_legacy_incompleto
               OR (
                 v_grupo.destino='APROBADO'
                 AND NOT (
                   v.afip_version >= 2
                   AND v.afip_snapshot IS NOT NULL
                   AND v.afip_snapshot->>'version'='2'
                   AND v.afip_snapshot_hash IS NOT NULL
                   AND v.afip_fecha_comprobante IS NOT NULL
                   AND v.afip_validez IS NOT NULL
                 )
               )
               OR (
                 v_grupo.destino='BLOQUEADO'
                 AND v.afip_numero IS NOT NULL
                 AND NOT (
                   v.afip_version >= 2
                   AND v.afip_snapshot IS NOT NULL
                   AND v.afip_snapshot->>'version'='2'
                   AND v.afip_snapshot_hash IS NOT NULL
                 )
               )
             )
       WHERE v.id=ANY(v_grupo.ids);
    END IF;

    estado_destino:=v_grupo.destino;
    cantidad:=v_grupo.cantidad;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_cola_fiscal(boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.backfill_cola_fiscal(boolean)
  TO service_role;

COMMENT ON FUNCTION public.backfill_cola_fiscal(boolean) IS
  'Dry-run por defecto. Clasifica estado/validez sin reconstruir receptor, fecha, PV ni snapshot y sin llamar a ARCA. Aplicar=true se reserva para el corte controlado posterior.';

-- ------------------------------------------------------------
-- 7. Índice parcial de la cola (la unicidad fiscal no se reemplaza)
-- ------------------------------------------------------------
CREATE INDEX idx_ventas_cola_fiscal
  ON public.ventas (sucursal_id,afip_estado,fecha DESC,id)
  WHERE afip_estado IN (
    'SIN_FACTURAR','EMITIENDO','APROBADO','ERROR_CORREGIBLE',
    'RECONCILIAR','CANCELADO','BLOQUEADO'
  );
