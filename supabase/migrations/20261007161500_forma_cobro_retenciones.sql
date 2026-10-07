-- Una retención entregada por el cliente cancela deuda, aunque no ingrese
-- efectivo ni transferencia. Venta_pagos usa este enum; cobranzas usa texto.
ALTER TYPE public.forma_pago ADD VALUE IF NOT EXISTS 'RETENCIONES' BEFORE 'MERCADO_PAGO';

ALTER TABLE public.cobranzas_cta_cte
  DROP CONSTRAINT IF EXISTS chk_cobranza_forma_pago;

ALTER TABLE public.cobranzas_cta_cte
  ADD CONSTRAINT chk_cobranza_forma_pago
  CHECK (forma_pago IS NULL OR forma_pago IN (
    'EFECTIVO', 'TRANSFERENCIA', 'TARJETA_DEBITO', 'TARJETA_CREDITO',
    'QR', 'CANJE', 'RETENCIONES', 'MERCADO_PAGO', 'CHEQUE', 'CTA_CTE'
  ));
