-- QR y Canje son formas independientes para registrar cobros.
-- MERCADO_PAGO permanece en el enum y en el CHECK para leer registros históricos.
ALTER TYPE public.forma_pago ADD VALUE IF NOT EXISTS 'QR' BEFORE 'MERCADO_PAGO';
ALTER TYPE public.forma_pago ADD VALUE IF NOT EXISTS 'CANJE' BEFORE 'MERCADO_PAGO';

ALTER TABLE public.cobranzas_cta_cte
  DROP CONSTRAINT IF EXISTS chk_cobranza_forma_pago;

ALTER TABLE public.cobranzas_cta_cte
  ADD CONSTRAINT chk_cobranza_forma_pago
  CHECK (forma_pago IS NULL OR forma_pago IN (
    'EFECTIVO', 'TRANSFERENCIA', 'TARJETA_DEBITO', 'TARJETA_CREDITO',
    'QR', 'CANJE', 'MERCADO_PAGO', 'CHEQUE', 'CTA_CTE'
  ));
