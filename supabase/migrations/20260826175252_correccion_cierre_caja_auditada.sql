-- Los cierres siguen sin poder editarse directamente. Esta versión agrega una
-- corrección administrativa transaccional, optimista y con auditoría inmutable.

ALTER TABLE public.caja_sesiones
  ADD COLUMN correccion_version integer NOT NULL DEFAULT 0
  CONSTRAINT caja_sesiones_correccion_version_no_negativa
  CHECK (correccion_version >= 0);

CREATE TABLE public.caja_cierre_correcciones (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caja_sesion_id uuid NOT NULL
    REFERENCES public.caja_sesiones(id) ON DELETE RESTRICT,
  corregida_por uuid NOT NULL
    REFERENCES public.profiles(id) ON DELETE RESTRICT,
  corregida_en timestamptz NOT NULL DEFAULT pg_catalog.now(),
  motivo text NOT NULL
    CONSTRAINT caja_cierre_correcciones_motivo_valido
    CHECK (char_length(btrim(motivo)) BETWEEN 5 AND 1000),
  version_anterior integer NOT NULL CHECK (version_anterior >= 0),
  version_nueva integer NOT NULL
    CHECK (version_nueva = version_anterior + 1),
  valores_anteriores jsonb NOT NULL
    CHECK (jsonb_typeof(valores_anteriores) = 'object'),
  valores_nuevos jsonb NOT NULL
    CHECK (jsonb_typeof(valores_nuevos) = 'object'),
  campos_modificados text[] NOT NULL
    CHECK (cardinality(campos_modificados) > 0),
  CONSTRAINT caja_cierre_correcciones_version_unica
    UNIQUE (caja_sesion_id,version_nueva)
);

CREATE INDEX caja_cierre_correcciones_sesion_fecha_idx
  ON public.caja_cierre_correcciones(caja_sesion_id,corregida_en DESC);
CREATE INDEX caja_cierre_correcciones_usuario_idx
  ON public.caja_cierre_correcciones(corregida_por);

ALTER TABLE public.caja_cierre_correcciones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.caja_cierre_correcciones
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.caja_cierre_correcciones
  TO authenticated,service_role;

CREATE POLICY "Sólo administradores leen correcciones de cierre"
ON public.caja_cierre_correcciones
FOR SELECT
TO authenticated
USING ((SELECT public.is_admin((SELECT auth.uid()))));

CREATE OR REPLACE FUNCTION public.bloquear_cambio_correccion_cierre()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=''
AS $$
BEGIN
  RAISE insufficient_privilege
    USING MESSAGE='La auditoría de correcciones de caja es inmutable';
END;
$$;

REVOKE ALL ON FUNCTION public.bloquear_cambio_correccion_cierre()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER caja_cierre_correcciones_inmutables
BEFORE UPDATE OR DELETE ON public.caja_cierre_correcciones
FOR EACH ROW EXECUTE FUNCTION public.bloquear_cambio_correccion_cierre();

CREATE OR REPLACE FUNCTION public.corregir_cierre_caja(
  p_sesion_id uuid,
  p_efectivo_contado numeric,
  p_efectivo_dejado numeric,
  p_notas text,
  p_motivo text,
  p_version_esperada integer
)
RETURNS TABLE(
  correccion_version integer,
  total_esperado numeric,
  total_contado numeric,
  total_diferencia numeric,
  efectivo_retirado numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sucursal_id uuid;
  v_sesion public.caja_sesiones%ROWTYPE;
  v_efectivo_contado numeric(14,2) := round(p_efectivo_contado,2);
  v_efectivo_dejado numeric(14,2) := round(p_efectivo_dejado,2);
  v_efectivo_anterior numeric(14,2);
  v_notas text := nullif(btrim(coalesce(p_notas,'')),'');
  v_motivo text := btrim(coalesce(p_motivo,''));
  v_contado jsonb;
  v_diferencia jsonb := '{}'::jsonb;
  v_formas text[];
  v_campos text[] := ARRAY[]::text[];
  v_forma text;
  v_esperado_forma numeric(14,2);
  v_contado_forma numeric(14,2);
  v_total_esperado numeric(14,2) := 0;
  v_total_contado numeric(14,2) := 0;
  v_valores_anteriores jsonb;
  v_valores_nuevos jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Iniciá sesión nuevamente para corregir el cierre.';
  END IF;
  IF NOT public.is_admin(v_uid) THEN
    RAISE EXCEPTION 'Sólo un administrador puede corregir un cierre de caja.';
  END IF;
  IF p_sesion_id IS NULL THEN
    RAISE EXCEPTION 'Elegí el cierre de caja que querés corregir.';
  END IF;
  IF p_efectivo_contado IS NULL OR p_efectivo_dejado IS NULL THEN
    RAISE EXCEPTION 'Completá el efectivo contado y el efectivo dejado.';
  END IF;
  IF v_efectivo_contado < 0 OR v_efectivo_dejado < 0 THEN
    RAISE EXCEPTION 'El efectivo contado y el dejado no pueden ser negativos.';
  END IF;
  IF v_efectivo_dejado > v_efectivo_contado THEN
    RAISE EXCEPTION 'El efectivo dejado no puede superar al efectivo contado.';
  END IF;
  IF char_length(v_motivo) < 5 OR char_length(v_motivo) > 1000 THEN
    RAISE EXCEPTION 'Escribí un motivo concreto para que la corrección quede auditada.';
  END IF;
  IF v_notas IS NOT NULL AND char_length(v_notas) > 2000 THEN
    RAISE EXCEPTION 'Las observaciones no pueden superar los 2000 caracteres.';
  END IF;
  IF p_version_esperada IS NULL OR p_version_esperada < 0 THEN
    RAISE EXCEPTION 'Volvé a abrir el cierre antes de corregirlo.';
  END IF;

  -- ORDEN DE LOCKS: primero el advisory de la sucursal y después la fila. Es el
  -- mismo protocolo que usan caja_sesion_actual(), abrir_caja() y cerrar_caja().
  -- La primera lectura sólo resuelve qué advisory tomar; toda decisión se vuelve
  -- a evaluar con la fila bloqueada. Así una apertura automática no puede tomar
  -- el fondo viejo mientras esta corrección está en curso.
  SELECT sucursal_id INTO v_sucursal_id
  FROM public.caja_sesiones
  WHERE id=p_sesion_id;

  IF v_sucursal_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_sucursal_id::text,0)
    );
  END IF;

  -- La versión detecta además una pantalla que quedó desactualizada.
  SELECT * INTO v_sesion
  FROM public.caja_sesiones
  WHERE id=p_sesion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El cierre de caja seleccionado ya no existe.';
  END IF;
  IF v_sesion.estado <> 'CERRADA' THEN
    RAISE EXCEPTION 'La caja todavía está abierta y no se puede corregir como cierre.';
  END IF;
  IF v_sesion.correccion_version <> p_version_esperada THEN
    RAISE EXCEPTION 'Otra persona corrigió este cierre. Cerrá esta ventana, revisá los cambios y volvé a intentarlo.';
  END IF;
  IF pg_catalog.jsonb_typeof(v_sesion.esperado) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_sesion.contado) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Este cierre histórico no conserva el detalle necesario para recalcularlo. Avisale a un administrador técnico.';
  END IF;

  v_efectivo_anterior := round(coalesce((v_sesion.contado->>'EFECTIVO')::numeric,0),2);

  IF v_efectivo_dejado IS DISTINCT FROM round(coalesce(v_sesion.efectivo_dejado,0),2)
     AND EXISTS (
       SELECT 1
       FROM public.caja_sesiones AS posterior
       WHERE posterior.sucursal_id=v_sesion.sucursal_id
         AND posterior.id<>v_sesion.id
         AND posterior.abierta_en>coalesce(v_sesion.cerrada_en,v_sesion.abierta_en)
     ) THEN
    RAISE EXCEPTION 'No se puede cambiar el efectivo dejado porque ya existe un turno posterior que tomó ese fondo inicial.';
  END IF;

  IF v_efectivo_contado IS NOT DISTINCT FROM v_efectivo_anterior
     AND v_efectivo_dejado IS NOT DISTINCT FROM round(coalesce(v_sesion.efectivo_dejado,0),2)
     AND v_notas IS NOT DISTINCT FROM nullif(btrim(coalesce(v_sesion.notas,'')),'') THEN
    RAISE EXCEPTION 'No hay cambios para guardar en este cierre.';
  END IF;

  v_contado := v_sesion.contado
    || pg_catalog.jsonb_build_object('EFECTIVO',v_efectivo_contado);

  SELECT pg_catalog.array_agg(forma ORDER BY forma)
  INTO v_formas
  FROM (
    SELECT pg_catalog.jsonb_object_keys(v_sesion.esperado) AS forma
    UNION
    SELECT pg_catalog.jsonb_object_keys(v_contado) AS forma
  ) AS formas;

  FOREACH v_forma IN ARRAY v_formas LOOP
    IF pg_catalog.jsonb_typeof(v_sesion.esperado->v_forma)='object' THEN
      IF v_sesion.esperado->v_forma ? 'neto'
         AND pg_catalog.jsonb_typeof(v_sesion.esperado->v_forma->'neto')<>'number' THEN
        RAISE EXCEPTION 'El cierre tiene un importe esperado incompatible en %. Avisale a un administrador técnico.',v_forma;
      END IF;
      v_esperado_forma := round(
        coalesce((v_sesion.esperado->v_forma->>'neto')::numeric,0),2
      );
    ELSIF pg_catalog.jsonb_typeof(v_sesion.esperado->v_forma)='number' THEN
      v_esperado_forma := round((v_sesion.esperado->>v_forma)::numeric,2);
    ELSIF v_sesion.esperado->v_forma IS NULL THEN
      v_esperado_forma := 0;
    ELSE
      RAISE EXCEPTION 'El cierre tiene un importe esperado incompatible en %. Avisale a un administrador técnico.',v_forma;
    END IF;

    IF v_contado->v_forma IS NULL THEN
      v_contado_forma := 0;
    ELSIF pg_catalog.jsonb_typeof(v_contado->v_forma)='number' THEN
      v_contado_forma := round((v_contado->>v_forma)::numeric,2);
    ELSE
      RAISE EXCEPTION 'El cierre tiene un importe contado incompatible en %. Avisale a un administrador técnico.',v_forma;
    END IF;

    v_contado := v_contado
      || pg_catalog.jsonb_build_object(v_forma,v_contado_forma);
    v_diferencia := v_diferencia
      || pg_catalog.jsonb_build_object(v_forma,round(v_contado_forma-v_esperado_forma,2));
    v_total_esperado := v_total_esperado+v_esperado_forma;
    v_total_contado := v_total_contado+v_contado_forma;
  END LOOP;

  v_total_esperado := round(v_total_esperado,2);
  v_total_contado := round(v_total_contado,2);

  IF v_efectivo_contado IS DISTINCT FROM v_efectivo_anterior THEN
    v_campos := pg_catalog.array_append(v_campos,'efectivo_contado');
  END IF;
  IF v_efectivo_dejado IS DISTINCT FROM round(coalesce(v_sesion.efectivo_dejado,0),2) THEN
    v_campos := pg_catalog.array_append(v_campos,'efectivo_dejado');
  END IF;
  IF v_notas IS DISTINCT FROM nullif(btrim(coalesce(v_sesion.notas,'')),'') THEN
    v_campos := pg_catalog.array_append(v_campos,'notas');
  END IF;

  v_valores_anteriores := pg_catalog.jsonb_build_object(
    'contado',v_sesion.contado,
    'diferencia',v_sesion.diferencia,
    'total_esperado',v_sesion.total_esperado,
    'total_contado',v_sesion.total_contado,
    'total_diferencia',v_sesion.total_diferencia,
    'efectivo_dejado',v_sesion.efectivo_dejado,
    'efectivo_retirado',round(v_efectivo_anterior-coalesce(v_sesion.efectivo_dejado,0),2),
    'notas',v_sesion.notas,
    'correccion_version',v_sesion.correccion_version
  );
  v_valores_nuevos := pg_catalog.jsonb_build_object(
    'contado',v_contado,
    'diferencia',v_diferencia,
    'total_esperado',v_total_esperado,
    'total_contado',v_total_contado,
    'total_diferencia',round(v_total_contado-v_total_esperado,2),
    'efectivo_dejado',v_efectivo_dejado,
    'efectivo_retirado',round(v_efectivo_contado-v_efectivo_dejado,2),
    'notas',v_notas,
    'correccion_version',v_sesion.correccion_version+1
  );

  UPDATE public.caja_sesiones
  SET contado=v_contado,
      diferencia=v_diferencia,
      total_esperado=v_total_esperado,
      total_contado=v_total_contado,
      total_diferencia=round(v_total_contado-v_total_esperado,2),
      efectivo_dejado=v_efectivo_dejado,
      notas=v_notas,
      correccion_version=v_sesion.correccion_version+1
  WHERE id=v_sesion.id;

  INSERT INTO public.caja_cierre_correcciones(
    caja_sesion_id,corregida_por,motivo,version_anterior,version_nueva,
    valores_anteriores,valores_nuevos,campos_modificados
  ) VALUES (
    v_sesion.id,v_uid,v_motivo,v_sesion.correccion_version,
    v_sesion.correccion_version+1,v_valores_anteriores,v_valores_nuevos,v_campos
  );

  RETURN QUERY SELECT
    v_sesion.correccion_version+1,
    v_total_esperado,
    v_total_contado,
    round(v_total_contado-v_total_esperado,2),
    round(v_efectivo_contado-v_efectivo_dejado,2);
END;
$$;

REVOKE ALL ON FUNCTION public.corregir_cierre_caja(uuid,numeric,numeric,text,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.corregir_cierre_caja(uuid,numeric,numeric,text,text,integer)
  TO authenticated;

COMMENT ON TABLE public.caja_cierre_correcciones IS
  'Historial inmutable de correcciones administrativas sobre cierres de caja.';
COMMENT ON FUNCTION public.corregir_cierre_caja(uuid,numeric,numeric,text,text,integer) IS
  'Corrige importes de efectivo y notas, recalcula el cierre y registra actor, motivo y antes/después en una sola transacción.';
