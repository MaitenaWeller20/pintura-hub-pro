-- ============================================================
-- Aislar los CAE simulados (modo mock) de la numeración fiscal real.
--
-- EL PROBLEMA QUE RESUELVE
-- Mientras el trámite con AFIP estuvo en curso, el sistema operó con
-- INVOICING_MOCK_MODE=true: cada comprobante recibió un CAE inventado y quedó
-- guardado con su afip_punto_venta / afip_cbte_tipo / afip_numero / afip_modo,
-- exactamente igual que uno real.
--
-- Eso rompe dos cosas el día que se apaga el mock:
--
--   1. La guarda anti-duplicación de emitirComprobante compara el último
--      comprobante que reconoce AFIP contra el último que figura acá
--      ("ultimoLocal"). Ese conteo tomaba también los CAE de mentira, así que al
--      apagar el mock con el punto de venta todavía en HOMOLOGACION daba
--      "acá figura el comprobante 20 pero AFIP sólo reconoce hasta el 0" y se
--      negaba a emitir. El mensaje además diagnostica mal: culpa a una mezcla de
--      ambientes cuando en realidad es basura de simulación.
--
--   2. El índice único uq_ventas_afip_numeracion no distingue simulado de real,
--      así que la primera emisión REAL que cayera en un número ya usado por un
--      mock (mismo PV, tipo y modo) chocaba con un 23505.
--
-- LA SOLUCIÓN
-- Una marca inmutable por comprobante. La numeración simulada y la real pasan a
-- ser dos espacios de nombres independientes: el conteo de "ultimoLocal" filtra
-- por el modo en el que se está emitiendo, y el índice único incluye la marca.
--
-- Con esto se puede apagar el mock y probar en HOMOLOGACION como corresponde
-- (Etapa 4 de FACTURACION-AFIP.md), sin tener que saltear derecho a producción
-- ni limpiar filas a mano.
-- ============================================================


-- ------------------------------------------------------------
-- 1. La marca
-- ------------------------------------------------------------
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS afip_simulado boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.ventas.afip_simulado IS
  'true = el CAE lo generó el modo simulado (INVOICING_MOCK_MODE), NO tiene validez legal '
  'y no participa de la numeración fiscal real. Se estampa al guardar el CAE y no se toca más.';


-- ------------------------------------------------------------
-- 2. Backfill de lo que ya está en la base
-- ------------------------------------------------------------
-- Todo CAE que exista en este momento es simulado: el sistema nunca emitió
-- contra AFIP de verdad (INVOICING_MOCK_MODE estuvo en true desde el principio).
-- Esta migración es justamente el paso previo al primer corte a real, así que la
-- condición se cumple por construcción.
--
-- Si por lo que fuera esta migración se corre DESPUÉS de haber emitido algún
-- comprobante real, acotá el WHERE por fecha antes de ejecutarla — marcar un CAE
-- real como simulado lo saca de la numeración y descoloca el contador.
DO $$
DECLARE v_n integer;
BEGIN
  UPDATE public.ventas
     SET afip_simulado = true
   WHERE cae IS NOT NULL
     AND afip_simulado = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'CAE simulados marcados: %', v_n;
END $$;


-- ------------------------------------------------------------
-- 3. El índice único, ahora separando simulado de real
-- ------------------------------------------------------------
-- Sigue impidiendo que dos ventas distintas tomen el mismo número fiscal, pero
-- ya no cruza la numeración de mentira con la de verdad.
DROP INDEX IF EXISTS public.uq_ventas_afip_numeracion;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_afip_numeracion
  ON public.ventas (afip_punto_venta, afip_cbte_tipo, afip_numero, afip_modo, afip_simulado)
  WHERE afip_numero IS NOT NULL;


-- ------------------------------------------------------------
-- 4. Que un comprobante simulado se distinga en el listado
-- ------------------------------------------------------------
-- guard_ventas_columnas ya impide que `authenticated` toque las columnas
-- fiscales; afip_simulado se suma a esa lista para que la marca sea inmutable
-- desde el navegador (sólo la escribe el servidor con la service_role key).
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
