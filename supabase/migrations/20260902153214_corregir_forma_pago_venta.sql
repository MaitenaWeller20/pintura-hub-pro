-- Un pago ya registrado sólo puede cambiar de medio a través de la RPC
-- administrativa. El importe, la venta y la sesión de caja quedan inmutables.

ALTER TABLE public.venta_pagos
  ADD COLUMN correccion_version integer NOT NULL DEFAULT 0
  CONSTRAINT venta_pagos_correccion_version_no_negativa
  CHECK (correccion_version>=0);

CREATE TABLE public.venta_pago_correcciones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  venta_pago_id uuid NOT NULL
    REFERENCES public.venta_pagos(id) ON DELETE RESTRICT,
  venta_id uuid NOT NULL
    REFERENCES public.ventas(id) ON DELETE RESTRICT,
  caja_sesion_id uuid
    REFERENCES public.caja_sesiones(id) ON DELETE RESTRICT,
  corregida_por uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  corregida_en timestamptz NOT NULL DEFAULT pg_catalog.now(),
  motivo text NOT NULL
    CONSTRAINT venta_pago_correcciones_motivo_valido
    CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 1000),
  version_anterior integer NOT NULL CHECK (version_anterior>=0),
  version_nueva integer NOT NULL CHECK (version_nueva=version_anterior+1),
  monto numeric(14,2) NOT NULL CHECK (monto>0),
  forma_pago_anterior public.forma_pago NOT NULL,
  forma_pago_nueva public.forma_pago NOT NULL,
  detalle_anterior jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(detalle_anterior)='object'),
  detalle_nuevo jsonb NOT NULL
    CHECK (pg_catalog.jsonb_typeof(detalle_nuevo)='object'),
  CONSTRAINT venta_pago_correcciones_forma_distinta
    CHECK (forma_pago_anterior<>forma_pago_nueva),
  CONSTRAINT venta_pago_correcciones_version_unica
    UNIQUE (venta_pago_id,version_nueva)
);

CREATE INDEX venta_pago_correcciones_pago_fecha_idx
  ON public.venta_pago_correcciones(venta_pago_id,corregida_en DESC);
CREATE INDEX venta_pago_correcciones_venta_idx
  ON public.venta_pago_correcciones(venta_id);
CREATE INDEX venta_pago_correcciones_caja_idx
  ON public.venta_pago_correcciones(caja_sesion_id)
  WHERE caja_sesion_id IS NOT NULL;
CREATE INDEX venta_pago_correcciones_usuario_idx
  ON public.venta_pago_correcciones(corregida_por);

ALTER TABLE public.venta_pago_correcciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.venta_pago_correcciones
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.venta_pago_correcciones
  TO authenticated,service_role;

CREATE POLICY "Sólo administradores leen correcciones de pagos"
ON public.venta_pago_correcciones
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin((SELECT auth.uid()))));

CREATE OR REPLACE FUNCTION public.bloquear_cambio_correccion_pago()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=''
AS $$
BEGIN
  RAISE insufficient_privilege
    USING MESSAGE='La auditoría de correcciones de pagos es inmutable';
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cambio_correccion_pago()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER venta_pago_correcciones_inmutables
BEFORE UPDATE OR DELETE ON public.venta_pago_correcciones
FOR EACH ROW EXECUTE FUNCTION public.bloquear_cambio_correccion_pago();

CREATE OR REPLACE FUNCTION public.corregir_forma_pago_venta(
  p_venta_pago_id uuid,
  p_forma_pago_nueva public.forma_pago,
  p_motivo text,
  p_version_esperada integer
)
RETURNS TABLE(
  pago_id uuid,
  venta_id uuid,
  forma_pago public.forma_pago,
  correccion_version integer,
  caja_sesion_id uuid,
  caja_correccion_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_venta_id uuid;
  v_pago public.venta_pagos%ROWTYPE;
  v_venta public.ventas%ROWTYPE;
  v_sesion public.caja_sesiones%ROWTYPE;
  v_caja_id uuid;
  v_caja_sucursal_id uuid;
  v_motivo text:=btrim(coalesce(p_motivo,''));
  v_forma_anterior public.forma_pago;
  v_detalle_anterior jsonb;
  v_version_anterior integer;
  v_esperado jsonb;
  v_contado jsonb:='{}'::jsonb;
  v_diferencia jsonb:='{}'::jsonb;
  v_formas text[];
  v_forma text;
  v_esperado_forma numeric(14,2);
  v_contado_forma numeric(14,2);
  v_total_esperado numeric(14,2):=0;
  v_total_contado numeric(14,2):=0;
  v_valores_anteriores jsonb;
  v_valores_nuevos jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Iniciá sesión nuevamente para corregir la forma de pago.';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede corregir la forma de pago.';
  END IF;
  IF p_venta_pago_id IS NULL THEN
    RAISE EXCEPTION 'Elegí el pago que querés corregir.';
  END IF;
  IF p_version_esperada IS NULL OR p_version_esperada<0 THEN
    RAISE EXCEPTION 'Volvé a abrir la venta antes de corregir el pago.';
  END IF;
  IF char_length(v_motivo)<5 THEN
    RAISE EXCEPTION 'Escribí un motivo concreto para que la corrección quede auditada.';
  END IF;
  IF char_length(v_motivo)>1000 THEN
    RAISE EXCEPTION 'El motivo no puede superar los 1000 caracteres.';
  END IF;

  -- ORDEN DE LOCKS: venta, pago, advisory de la caja efectiva y fila de caja.
  -- `anular_venta` también bloquea primero la venta; la caja usa siempre el
  -- advisory de su sucursal antes de decidir si está abierta o cerrada.
  SELECT vp.venta_id INTO v_venta_id
  FROM public.venta_pagos AS vp
  WHERE vp.id=p_venta_pago_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pago seleccionado ya no existe.';
  END IF;

  SELECT v.* INTO v_venta
  FROM public.ventas AS v
  WHERE v.id=v_venta_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La venta seleccionada ya no existe.';
  END IF;

  SELECT vp.* INTO v_pago
  FROM public.venta_pagos AS vp
  WHERE vp.id=p_venta_pago_id
    AND vp.venta_id=v_venta.id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pago seleccionado ya no existe.';
  END IF;

  IF v_venta.estado<>'ACTIVA' THEN
    RAISE EXCEPTION 'No se puede corregir un pago de una venta anulada.';
  END IF;
  IF v_pago.monto<=0 THEN
    RAISE EXCEPTION 'Sólo se puede corregir un pago con importe positivo.';
  END IF;
  IF v_pago.forma_pago='CTA_CTE' OR p_forma_pago_nueva='CTA_CTE' THEN
    RAISE EXCEPTION 'Cuenta corriente no es una forma de pago corregible.';
  END IF;
  IF v_pago.forma_pago=p_forma_pago_nueva THEN
    RAISE EXCEPTION 'Elegí una forma de pago distinta de la actual.';
  END IF;
  IF v_pago.correccion_version<>p_version_esperada THEN
    RAISE EXCEPTION 'Otra persona corrigió este pago. Cerrá esta ventana, revisá los cambios y volvé a intentarlo.';
  END IF;

  v_caja_id:=coalesce(v_pago.caja_sesion_id,v_venta.caja_sesion_id);
  IF v_caja_id IS NOT NULL THEN
    SELECT cs.sucursal_id INTO v_caja_sucursal_id
    FROM public.caja_sesiones AS cs
    WHERE cs.id=v_caja_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La sesión de caja asociada al pago ya no existe.';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_caja_sucursal_id::text,0)
    );

    SELECT cs.* INTO v_sesion
    FROM public.caja_sesiones AS cs
    WHERE cs.id=v_caja_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'La sesión de caja asociada al pago ya no existe.';
    END IF;
  END IF;

  v_forma_anterior:=v_pago.forma_pago;
  v_detalle_anterior:=v_pago.detalle;
  v_version_anterior:=v_pago.correccion_version;

  UPDATE public.venta_pagos AS vp
  SET forma_pago=p_forma_pago_nueva,
      detalle='{}'::jsonb,
      correccion_version=vp.correccion_version+1
  WHERE vp.id=v_pago.id
  RETURNING vp.* INTO v_pago;

  INSERT INTO public.venta_pago_correcciones(
    venta_pago_id,venta_id,caja_sesion_id,corregida_por,motivo,
    version_anterior,version_nueva,monto,
    forma_pago_anterior,forma_pago_nueva,detalle_anterior,detalle_nuevo
  ) VALUES (
    v_pago.id,v_pago.venta_id,v_caja_id,v_uid,v_motivo,
    v_version_anterior,v_pago.correccion_version,v_pago.monto,
    v_forma_anterior,v_pago.forma_pago,v_detalle_anterior,v_pago.detalle
  );

  IF v_caja_id IS NOT NULL AND v_sesion.estado='CERRADA' THEN
    IF pg_catalog.jsonb_typeof(v_sesion.contado) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'El cierre tiene un importe contado incompatible. Avisale a un administrador técnico.';
    END IF;

    v_esperado:=public.caja_esperado(v_caja_id);
    IF pg_catalog.jsonb_typeof(v_esperado) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'No se pudo reconstruir el esperado del cierre. Avisale a un administrador técnico.';
    END IF;

    SELECT pg_catalog.array_agg(formas.forma ORDER BY formas.forma)
    INTO v_formas
    FROM (
      SELECT pg_catalog.jsonb_object_keys(v_esperado) AS forma
      UNION
      SELECT pg_catalog.jsonb_object_keys(v_sesion.contado) AS forma
      UNION
      SELECT 'EFECTIVO'::text AS forma
    ) AS formas;

    FOREACH v_forma IN ARRAY v_formas LOOP
      IF pg_catalog.jsonb_typeof(v_esperado->v_forma)='object' THEN
        IF v_esperado->v_forma ? 'neto'
           AND pg_catalog.jsonb_typeof(v_esperado->v_forma->'neto')<>'number' THEN
          RAISE EXCEPTION 'El cierre tiene un importe esperado incompatible en %. Avisale a un administrador técnico.',v_forma;
        END IF;
        v_esperado_forma:=pg_catalog.round(
          coalesce((v_esperado->v_forma->>'neto')::numeric,0),2
        );
      ELSIF pg_catalog.jsonb_typeof(v_esperado->v_forma)='number' THEN
        v_esperado_forma:=pg_catalog.round((v_esperado->>v_forma)::numeric,2);
      ELSIF v_esperado->v_forma IS NULL THEN
        v_esperado_forma:=0;
      ELSE
        RAISE EXCEPTION 'El cierre tiene un importe esperado incompatible en %. Avisale a un administrador técnico.',v_forma;
      END IF;

      IF v_forma='EFECTIVO' THEN
        IF v_sesion.contado->v_forma IS NULL THEN
          v_contado_forma:=0;
        ELSIF pg_catalog.jsonb_typeof(v_sesion.contado->v_forma)='number' THEN
          v_contado_forma:=pg_catalog.round((v_sesion.contado->>v_forma)::numeric,2);
        ELSE
          RAISE EXCEPTION 'El cierre tiene un importe contado incompatible en %. Avisale a un administrador técnico.',v_forma;
        END IF;
      ELSE
        -- Sólo el efectivo es un conteo físico. Para los demás medios, el
        -- cierre refleja exactamente el esperado reconstruido.
        v_contado_forma:=v_esperado_forma;
      END IF;

      v_contado:=v_contado
        || pg_catalog.jsonb_build_object(v_forma,v_contado_forma);
      v_diferencia:=v_diferencia
        || pg_catalog.jsonb_build_object(
          v_forma,pg_catalog.round(v_contado_forma-v_esperado_forma,2)
        );
      v_total_esperado:=v_total_esperado+v_esperado_forma;
      v_total_contado:=v_total_contado+v_contado_forma;
    END LOOP;

    v_total_esperado:=pg_catalog.round(v_total_esperado,2);
    v_total_contado:=pg_catalog.round(v_total_contado,2);

    v_valores_anteriores:=pg_catalog.jsonb_build_object(
      'pago',pg_catalog.jsonb_build_object(
        'id',v_pago.id,
        'venta_id',v_pago.venta_id,
        'forma_pago',v_forma_anterior,
        'monto',v_pago.monto,
        'detalle',v_detalle_anterior,
        'correccion_version',v_version_anterior
      ),
      'esperado',v_sesion.esperado,
      'contado',v_sesion.contado,
      'diferencia',v_sesion.diferencia,
      'total_esperado',v_sesion.total_esperado,
      'total_contado',v_sesion.total_contado,
      'total_diferencia',v_sesion.total_diferencia,
      'efectivo_dejado',v_sesion.efectivo_dejado,
      'notas',v_sesion.notas,
      'correccion_version',v_sesion.correccion_version
    );
    v_valores_nuevos:=pg_catalog.jsonb_build_object(
      'pago',pg_catalog.jsonb_build_object(
        'id',v_pago.id,
        'venta_id',v_pago.venta_id,
        'forma_pago',v_pago.forma_pago,
        'monto',v_pago.monto,
        'detalle',v_pago.detalle,
        'correccion_version',v_pago.correccion_version
      ),
      'esperado',v_esperado,
      'contado',v_contado,
      'diferencia',v_diferencia,
      'total_esperado',v_total_esperado,
      'total_contado',v_total_contado,
      'total_diferencia',pg_catalog.round(v_total_contado-v_total_esperado,2),
      'efectivo_dejado',v_sesion.efectivo_dejado,
      'notas',v_sesion.notas,
      'correccion_version',v_sesion.correccion_version+1
    );

    UPDATE public.caja_sesiones AS cs
    SET esperado=v_esperado,
        contado=v_contado,
        diferencia=v_diferencia,
        total_esperado=v_total_esperado,
        total_contado=v_total_contado,
        total_diferencia=pg_catalog.round(v_total_contado-v_total_esperado,2),
        correccion_version=v_sesion.correccion_version+1
    WHERE cs.id=v_sesion.id;

    INSERT INTO public.caja_cierre_correcciones(
      caja_sesion_id,corregida_por,motivo,version_anterior,version_nueva,
      valores_anteriores,valores_nuevos,campos_modificados
    ) VALUES (
      v_sesion.id,v_uid,v_motivo,v_sesion.correccion_version,
      v_sesion.correccion_version+1,v_valores_anteriores,v_valores_nuevos,
      ARRAY['forma_pago_venta']
    );
  END IF;

  RETURN QUERY SELECT
    v_pago.id,
    v_pago.venta_id,
    v_pago.forma_pago,
    v_pago.correccion_version,
    v_caja_id,
    CASE
      WHEN v_caja_id IS NOT NULL AND v_sesion.estado='CERRADA'
        THEN v_sesion.correccion_version+1
      ELSE NULL
    END;
END;
$$;

REVOKE ALL ON FUNCTION public.corregir_forma_pago_venta(uuid,public.forma_pago,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.corregir_forma_pago_venta(uuid,public.forma_pago,text,integer)
  TO authenticated;

COMMENT ON COLUMN public.venta_pagos.correccion_version IS
  'Versión optimista de correcciones administrativas del medio de pago.';
COMMENT ON TABLE public.venta_pago_correcciones IS
  'Historial inmutable de cambios administrativos de forma de pago.';
COMMENT ON FUNCTION public.corregir_forma_pago_venta(uuid,public.forma_pago,text,integer) IS
  'Cambia sólo la forma de un pago positivo activo, audita y recalcula atómicamente un cierre de caja afectado.';
