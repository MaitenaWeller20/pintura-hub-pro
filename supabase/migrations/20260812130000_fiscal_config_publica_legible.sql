-- ============================================================
-- Que el navegador pueda leer los datos públicos del emisor.
--
-- `fiscal_config` tiene RLS activo y CERO policies, a propósito: adentro viven
-- la clave y el certificado de ARCA encriptados, y sólo se leen desde funciones
-- de servidor con la service role (ver el comentario de src/lib/fiscal.functions.ts).
--
-- Para que el navegador pudiera mostrar lo NO secreto (razón social, CUIT,
-- domicilio) se creó la vista `fiscal_config_publica`, que expone sólo esas
-- columnas y del certificado únicamente si existe o no. Pero quedó con
-- `security_invoker = true`, así que corre con los permisos de quien consulta
-- y hereda el bloqueo total de la tabla: devuelve CERO filas.
--
-- Consecuencia, silenciosa porque el código usa `fiscal?.razon_social ?? ...`:
--   * el PDF del presupuesto se titula "Presupuesto" en vez del nombre de la
--     empresa, y sale sin CUIT ni domicilio;
--   * el comprobante de pago a proveedor, igual.
-- Son papeles que se le entregan al cliente y al proveedor sin identificar quién
-- los emite. En local además tira 403 en la consola, porque ahí `authenticated`
-- ni siquiera tiene el GRANT sobre la tabla.
--
-- La vista pasa a correr con los permisos de su dueño, que es justamente para lo
-- que se creó: es la frontera que deja pasar lo público y deja adentro lo
-- secreto. Las columnas encriptadas no se exponen ni acá ni después — la vista
-- sólo publica `tiene_clave` y `tiene_certificado` como booleanos.
-- ============================================================

ALTER VIEW public.fiscal_config_publica SET (security_invoker = false);

-- El GRANT directo sobre la tabla no habilita nada hoy (RLS sin policies bloquea
-- todo igual), pero es una trampa: el día que alguien agregue una policy
-- permisiva, la clave y el certificado encriptados quedarían al alcance de
-- cualquier usuario logueado. El camino al dato público es la vista.
REVOKE SELECT ON public.fiscal_config FROM authenticated, anon;

GRANT SELECT ON public.fiscal_config_publica TO authenticated;
