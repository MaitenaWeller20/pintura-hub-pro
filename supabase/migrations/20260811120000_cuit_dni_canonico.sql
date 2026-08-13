-- ============================================================
-- CUIT/DNI canónico: la columna guarda sólo dígitos.
--
-- El problema: `cuit_dni` venía guardándose en DOS formatos según quién
-- escribiera. La importación de la migración de 3C dejaba el texto crudo del
-- archivo ("30-71582607-7") y el formulario guarda sólo dígitos
-- ("30715826077"). Todo lo que COMPARA normaliza —el índice único
-- `uq_clientes_cuit_dni_activo` indexa `regexp_replace(cuit_dni,'\D','','g')`—
-- pero todo lo que el usuario BUSCA compara el texto crudo.
--
-- Resultado en producción: dar de alta un cliente con CUIT 30715826077 choca
-- contra la ficha migrada "30-71582607-7" y tira 23505 ("Ya existe un cliente
-- con ese CUIT/DNI"), pero buscar 30715826077 en la pantalla de Clientes no
-- devuelve nada. La usuaria queda trabada sin forma de averiguar quién tiene
-- ese documento.
--
-- La cura de fondo es que la columna tenga UN solo formato. Se elige el de
-- dígitos, que es el que ya usan el índice, la deduplicación de la importación
-- y AFIP (`docTipoAfip`/`docNroAfip` en src/lib/fiscal/codigos.ts). Los guiones
-- pasan a ser cosa de la vista (`fmtDocumento` en src/lib/format.ts).
--
-- Ver docs/superpowers/specs/2026-08-11-cuit-canonico-design.md
-- ============================================================

-- ------------------------------------------------------------
-- 1. La regla, una sola, compartida por el backfill y el trigger
-- ------------------------------------------------------------
-- Si el valor NO tiene letras y tiene al menos un dígito -> se queda con los
-- dígitos. Si tiene letras, se deja intacto.
--
-- Lo de las letras no es un detalle: hay documentos alfanuméricos (un pasaporte
-- tipo "AAB123456"). Normalizarlo a "123456" no sólo perdería información, lo
-- haría COLISIONAR en el índice único contra un DNI 123456. Y de paso deja
-- pasar los placeholders legacy ("S/D", "sin doc"), que el índice ya excluye
-- por su `regexp_replace(...) <> ''`.
CREATE OR REPLACE FUNCTION public.normalizar_cuit_dni(v text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN v IS NULL                                THEN NULL
    WHEN v ~ '[A-Za-z]'                           THEN v
    WHEN regexp_replace(v, '\D', '', 'g') = ''    THEN v
    ELSE regexp_replace(v, '\D', '', 'g')
  END;
$$;

COMMENT ON FUNCTION public.normalizar_cuit_dni(text) IS
  'Deja el CUIT/DNI en su forma canónica (sólo dígitos). No toca valores con letras '
  '(pasaportes, placeholders "S/D") ni los que no tienen ningún dígito.';

-- ------------------------------------------------------------
-- 2. Backfill
-- ------------------------------------------------------------
-- Seguro respecto del índice único: el índice YA indexa la forma normalizada,
-- así que la clave indexada de cada fila no cambia con este UPDATE. Si dos
-- filas activas colisionaran al normalizar, el índice no se habría podido
-- crear en su momento.
--
-- Efecto colateral aceptado: mueve `updated_at` de las filas que toca (por el
-- trigger `set_updated_at`).
--
-- `trg_clientes_guard_credito` SÍ se dispara en cada fila (es BEFORE INSERT OR
-- UPDATE sin lista de columnas), pero no aborta por dos razones independientes:
-- corriendo la migración `auth.uid()` es NULL y el guard devuelve NEW en la
-- primera línea, y aunque no lo fuera, sólo aborta si cambian
-- condicion_cta_cte / limite_credito / es_generico, que acá no se tocan.
--
-- Idempotente: la segunda corrida no modifica ninguna fila.
UPDATE public.clientes
   SET cuit_dni = public.normalizar_cuit_dni(cuit_dni)
 WHERE cuit_dni IS NOT NULL
   AND cuit_dni IS DISTINCT FROM public.normalizar_cuit_dni(cuit_dni);

UPDATE public.proveedores
   SET cuit_dni = public.normalizar_cuit_dni(cuit_dni)
 WHERE cuit_dni IS NOT NULL
   AND cuit_dni IS DISTINCT FROM public.normalizar_cuit_dni(cuit_dni);

-- ------------------------------------------------------------
-- 3. Trigger: que no se vuelva a partir en dos formatos
-- ------------------------------------------------------------
-- Sin esto el backfill es un parche con fecha de vencimiento: la próxima
-- importación volvería a meter guiones. El trigger cubre al formulario, a la
-- importación y al SQL a mano por igual.
CREATE OR REPLACE FUNCTION public.tg_normalizar_cuit_dni()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.cuit_dni := public.normalizar_cuit_dni(NEW.cuit_dni);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS normalizar_cuit_dni ON public.clientes;
CREATE TRIGGER normalizar_cuit_dni
  BEFORE INSERT OR UPDATE OF cuit_dni ON public.clientes
  FOR EACH ROW EXECUTE FUNCTION public.tg_normalizar_cuit_dni();

DROP TRIGGER IF EXISTS normalizar_cuit_dni ON public.proveedores;
CREATE TRIGGER normalizar_cuit_dni
  BEFORE INSERT OR UPDATE OF cuit_dni ON public.proveedores
  FOR EACH ROW EXECUTE FUNCTION public.tg_normalizar_cuit_dni();
