-- La cola conserva toda su autorización explícita por auth.uid(), capacidad,
-- perfil activo, asignación y sucursal. La frontera definer se limita a
-- atravesar las tablas fiscales cerradas y los validadores owner-only; no se
-- expone ningún helper de snapshot a los roles API.
ALTER FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) SECURITY DEFINER;

ALTER FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) OWNER TO postgres;

ALTER FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) SET search_path='';

REVOKE ALL ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) TO authenticated;

COMMENT ON FUNCTION public.cola_fiscal_lectura(
  text,integer,integer,date,date,uuid,uuid,text,text,uuid
) IS
  'Cola fiscal v2/v3 definer auditada: revalida auth/capacidad/sucursal y no expone validadores owner-only.';
