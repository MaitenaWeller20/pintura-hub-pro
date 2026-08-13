#!/usr/bin/env bash
# ============================================================
# e2e SQL de presupuestos (migración 20260729160000).
#   supabase migration up --local && ./scripts/crear-admin-local.sh
#   ./scripts/test-presupuestos.sh
# Cubre la §8 del spec 2026-07-29-presupuestos-design.md.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL="docker exec -i supabase_db_local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
fallos=0
chequear() {
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; else echo "  ✗ $1 — esperaba '$2', obtuvo '$3'"; fallos=$((fallos+1)); fi
}
q() { $PSQL -tAc "$1"; }
auth() {
  cat <<SQL
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT id::text FROM auth.users WHERE email='$1'),
                    'role','authenticated')::text, false);
SQL
}

echo "── Sembrando ─────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.presupuesto_items i USING public.presupuestos p
 WHERE p.id=i.presupuesto_id AND p.observaciones IS NOT DISTINCT FROM 'TEST-PRES';
DELETE FROM public.presupuestos WHERE observaciones IS NOT DISTINCT FROM 'TEST-PRES';
-- La corrida anterior dejó una VENTA que referencia el producto: sin borrarla
-- primero, el DELETE del producto choca contra la FK y el script no es
-- repetible. La segunda corrida mediría otra cosa.
DELETE FROM public.venta_pagos vp USING public.ventas v
 WHERE v.id = vp.venta_id AND v.observaciones ~ '^(Presupuesto .*-PRES-|VENTA AJENA TEST)';
DELETE FROM public.cuenta_corriente_movimientos ccm USING public.ventas v
 WHERE v.id = ccm.venta_id AND v.observaciones ~ '^(Presupuesto .*-PRES-|VENTA AJENA TEST)';
DELETE FROM public.venta_items vi USING public.ventas v
 WHERE v.id = vi.venta_id AND v.observaciones ~ '^(Presupuesto .*-PRES-|VENTA AJENA TEST)';
UPDATE public.presupuestos SET estado='ANULADO', venta_id=NULL
 WHERE venta_id IN (SELECT id FROM public.ventas WHERE observaciones ~ '^(Presupuesto .*-PRES-|VENTA AJENA TEST)');
DELETE FROM public.ventas WHERE observaciones ~ '^(Presupuesto .*-PRES-|VENTA AJENA TEST)';
DELETE FROM public.stock_movimientos m USING public.productos p
 WHERE p.id=m.producto_id AND p.codigo='PRE-TEST';
DELETE FROM public.stock_sucursal s USING public.productos p
 WHERE p.id=s.producto_id AND p.codigo='PRE-TEST';
DELETE FROM public.productos WHERE codigo='PRE-TEST';
DELETE FROM public.clientes WHERE razon_social IN ('CLIENTE PRES TEST','OTRO PRES TEST');

INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje,activo,archivado)
VALUES ('PRE-TEST','PRODUCTO PRESUPUESTO',10000,21,true,false);
INSERT INTO public.clientes (razon_social, condicion_cta_cte)
VALUES ('CLIENTE PRES TEST', true), ('OTRO PRES TEST', true);
INSERT INTO public.stock_sucursal (producto_id, sucursal_id, cantidad)
VALUES ((SELECT id FROM public.productos WHERE codigo='PRE-TEST'),
        (SELECT id FROM public.sucursales ORDER BY numero LIMIT 1), 100)
ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = 100;
SQL

SUC=$(q "select id::text from public.sucursales order by numero limit 1")
PROD=$(q "select id::text from public.productos where codigo='PRE-TEST'")
CLI=$(q "select id::text from public.clientes where razon_social='CLIENTE PRES TEST'")
OTRO=$(q "select id::text from public.clientes where razon_social='OTRO PRES TEST'")

echo "── 1. Crear un presupuesto no toca nada ──────────────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',3,'descuento_porcentaje',10)),
  NULL, 'Juan de la esquina', NULL, 'TEST-PRES');
SQL
PRES=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES'")
chequear "queda guardado" "1" "$(q "select count(*)::text from public.presupuestos where id='$PRES'")"
chequear "tiene número" "1" "$(q "select count(*)::text from public.presupuestos where id='$PRES' and numero like '%-PRES-%'")"
chequear "NO mueve stock" "100.00" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
chequear "NO genera deuda" "0" \
  "$(q "select count(*)::text from public.cuenta_corriente_movimientos where cliente_id='$CLI'")"
# El precio lo pone el SERVIDOR: 10000 − 10% = 9000.
chequear "el precio sale del catálogo con el descuento" "9000.00" \
  "$(q "select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='$PRES'")"
chequear "guarda el precio de lista aparte" "10000.00" \
  "$(q "select precio_lista_sin_iva::text from public.presupuesto_items where presupuesto_id='$PRES'")"
chequear "el total es 3 × 9000 + IVA" "32670.00" \
  "$(q "select total::text from public.presupuestos where id='$PRES'")"

echo "── 2. Un precio inventado en el payload se ignora ────────"
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1,
    'precio_unitario_sin_iva',1,'precio_sin_iva',1)),
  NULL, 'Truchito', NULL, 'TEST-PRES');
SQL
TRUCHO=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Truchito'")
chequear "el servidor pone el precio real, no el del payload" "10000.00" \
  "$(q "select precio_sin_iva::text from public.presupuesto_items where presupuesto_id='$TRUCHO'")"

echo "── 3. EL PUNTO: convertir usa el precio PRESUPUESTADO ────"
# Se presupuestó a 9000. Ahora el producto sube a 15000.
$PSQL -c "UPDATE public.productos SET precio_sin_iva = 15000 WHERE codigo='PRE-TEST';" > /dev/null
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$PRES'::uuid, '$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta,
  '[]'::jsonb, gen_random_uuid());
SQL
VENTA=$(q "select venta_id::text from public.presupuestos where id='$PRES'")
chequear "la venta usa el precio del presupuesto, no el de hoy" "9000.00" \
  "$(q "select precio_unitario_sin_iva::text from public.venta_items where venta_id='$VENTA'")"
chequear "el presupuesto queda CONVERTIDO" "CONVERTIDO" \
  "$(q "select estado from public.presupuestos where id='$PRES'")"
chequear "y apunta a su venta" "1" \
  "$(q "select count(*)::text from public.presupuestos where id='$PRES' and venta_id is not null")"
echo "── 4. La conversión SÍ es una venta normal ───────────────"
chequear "descuenta stock (100 − 3)" "97.00" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
chequear "genera la deuda de cuenta corriente" "1" \
  "$(q "select count(*)::text from public.cuenta_corriente_movimientos where cliente_id='$CLI'")"
chequear "deja kardex de VENTA" "1" \
  "$(q "select count(*)::text from public.stock_movimientos m join public.productos p on p.id=m.producto_id where p.codigo='PRE-TEST' and m.tipo='VENTA'")"

echo "── 5. Reintentar la MISMA conversión ─────────────────────"
# Si se perdió la respuesta (mobile, pestaña cerrada), el segundo intento tiene
# que devolver la venta que ya se hizo, no un error — y sobre todo no una
# segunda venta que descuente el stock de nuevo.
VENTA1=$(q "select venta_id::text from public.presupuestos where id='$PRES'")
stock1=$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")
VENTA2=$($PSQL -tA <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT venta_id::text FROM public.convertir_presupuesto_en_venta('$PRES'::uuid, '$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
chequear "el reintento devuelve la MISMA venta" "$VENTA1" "$(echo "$VENTA2" | tail -1)"
chequear "no descontó stock dos veces" "$stock1" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
chequear "no creó una segunda venta" "1" \
  "$(q "select count(*)::text from public.ventas where observaciones like 'Presupuesto %' and id='$VENTA1'")"

out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$PRES'::uuid, '$OTRO'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "a nombre de otro cliente"; then echo "  ✓ avisa si el reintento viene con otro cliente"; else echo "  ✗ aceptó cambiar el cliente"; fallos=$((fallos+1)); fi

echo "── 6. Validaciones y estados ─────────────────────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$TRUCHO'::uuid, NULL,
  'FACTURA_B'::public.tipo_comprobante, 'CONTADO'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "elegir el cliente"; then echo "  ✓ exige cliente al convertir"; else echo "  ✗ convirtió sin cliente"; fallos=$((fallos+1)); fi

out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.anular_presupuesto('$PRES'::uuid);
SQL
)
if echo "$out" | grep -qi "ya se convirtió"; then echo "  ✓ no deja anular uno convertido"; else echo "  ✗ anuló uno convertido"; fallos=$((fallos+1)); fi

$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.anular_presupuesto('$TRUCHO'::uuid);
SQL
chequear "anular uno abierto sí anda" "ANULADO" "$(q "select estado from public.presupuestos where id='$TRUCHO'")"

# El CHECK que hace imposible "convertido pero no se sabe en qué venta".
out=$($PSQL -c "UPDATE public.presupuestos SET estado='CONVERTIDO' WHERE id='$TRUCHO';" 2>&1 || true)
if echo "$out" | grep -qi "presupuesto_convertido_tiene_venta"; then
  echo "  ✓ no se puede quedar CONVERTIDO sin venta"
else echo "  ✗ aceptó CONVERTIDO sin venta"; fallos=$((fallos+1)); fi

echo "── 7. Descuento inválido e IVA que cambió ────────────────"
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1,'descuento_porcentaje',150)),
  NULL, 'Malo', NULL, 'TEST-PRES');
SQL
)
if echo "$out" | grep -qi "Descuento inválido"; then echo "  ✓ rechaza un descuento de 150 (antes lo clampaba)"; else echo "  ✗ aceptó descuento 150"; fallos=$((fallos+1)); fi

# El IVA no se puede congelar (crear_venta usa el del producto). Si cambió, el
# total del presupuesto ya no es el que se cobraría.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  NULL, 'IVA cambiado', NULL, 'TEST-PRES');
SQL
IVAP=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='IVA cambiado'")
$PSQL -c "UPDATE public.productos SET iva_porcentaje = 10.5 WHERE codigo='PRE-TEST';" > /dev/null
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$IVAP'::uuid, '$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante, 'CTA_CTE'::public.condicion_venta, '[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "Cambió el IVA"; then echo "  ✓ no convierte si cambió el IVA"; else echo "  ✗ convirtió con el IVA cambiado"; fallos=$((fallos+1)); fi
$PSQL -c "UPDATE public.productos SET iva_porcentaje = 21 WHERE codigo='PRE-TEST';" > /dev/null

echo "── 8. Hallazgos del review adversarial ───────────────────"
# La clave de idempotencia la elegía quien llama, y crear_venta devuelve la venta
# VIEJA si ya existe: mandando la misma clave en dos presupuestos, el segundo
# quedaba CONVERTIDO apuntando a la venta del primero. La mercadería nunca salía
# del stock y nadie la cobraba.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  NULL, 'Idem A', NULL, 'TEST-PRES');
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',5)),
  NULL, 'Idem B', NULL, 'TEST-PRES');
SQL
IA=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Idem A'")
IB=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Idem B'")
MISMA='88888888-8888-8888-8888-888888888888'
stock0=$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$IA'::uuid,'$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante,'CTA_CTE'::public.condicion_venta,'[]'::jsonb,'$MISMA'::uuid);
SELECT public.convertir_presupuesto_en_venta('$IB'::uuid,'$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante,'CTA_CTE'::public.condicion_venta,'[]'::jsonb,'$MISMA'::uuid);
SQL
chequear "la misma clave NO hace que dos presupuestos compartan venta" "2" \
  "$(q "select count(distinct venta_id)::text from public.presupuestos where id in ('$IA','$IB')")"
chequear "el stock bajó por los dos (1 + 5)" \
  "$(q "select ($stock0 - 6)::text")" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"

# El guard de comprobante estaba SÓLO en la pantalla: por RPC directa se llegaba
# a cobrar sin que la plata entrara a la caja.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  NULL, 'Remito', NULL, 'TEST-PRES');
SQL
REM=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Remito'")
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$REM'::uuid,'$CLI'::uuid,
  'REMITO'::public.tipo_comprobante,'CONTADO'::public.condicion_venta,'[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "se convierte en factura"; then echo "  ✓ la RPC rechaza un remito, no sólo la pantalla"; else echo "  ✗ aceptó REMITO por RPC"; fallos=$((fallos+1)); fi

# NaN: `v_cant <= 0` es false y `NaN > 0` es true, así que ninguna comparación
# normal lo atrapa. Llegaba a dejar total = NaN.
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad','NaN')),
  NULL, 'NaN', NULL, 'TEST-PRES');
SQL
)
if echo "$out" | grep -qi "Cantidad inválida"; then echo "  ✓ rechaza una cantidad NaN"; else echo "  ✗ aceptó NaN"; fallos=$((fallos+1)); fi

echo "── 9. Hallazgos del code review de Codex ─────────────────"
# CONTADO sin pagos: la venta quedaba CONTADO/PENDIENTE/total_pagado=0. La
# mercadería sale, no entra a la caja y tampoco genera deuda: la plata no está
# en ningún lado.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',2)),
  NULL, 'Sin cobrar', NULL, 'TEST-PRES');
SQL
SINPAGO=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Sin cobrar'")
stockA=$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$SINPAGO'::uuid,'$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante,'CONTADO'::public.condicion_venta,'[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "aunque sea una parte"; then echo "  ✓ una conversión contado sin cobrar nada se rechaza"; else echo "  ✗ sacó la mercadería sin cobrarla"; fallos=$((fallos+1)); fi
chequear "y no tocó el stock" "$stockA" \
  "$(q "select cantidad::text from public.stock_sucursal s join public.productos p on p.id=s.producto_id where p.codigo='PRE-TEST'")"
# Un pago que cubre el total sí pasa.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$SINPAGO'::uuid,'$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante,'CONTADO'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('forma_pago','EFECTIVO','monto',
    (SELECT total FROM public.presupuestos WHERE id='$SINPAGO'))), gen_random_uuid());
SQL
chequear "con el pago completo sí convierte y queda PAGADO" "PAGADO" \
  "$(q "select v.estado_pago::text from public.ventas v join public.presupuestos p on p.venta_id=v.id where p.id='$SINPAGO'")"

# La clave derivada NO puede chocar con la de una venta normal: si choca,
# crear_venta devuelve la venta VIEJA y el presupuesto queda apuntando a una
# venta ajena, sin items propios ni stock movido.
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_presupuesto('$SUC'::uuid,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  NULL, 'Clave', NULL, 'TEST-PRES');
SQL
CHOQUE=$(q "select id::text from public.presupuestos where observaciones='TEST-PRES' and nombre_cliente='Clave'")
$PSQL > /dev/null <<SQL
$(auth admin@local.test)
SELECT public.crear_venta('$SUC'::uuid,'$CLI'::uuid,'FACTURA_B'::public.tipo_comprobante,
  'CTA_CTE'::public.condicion_venta,
  jsonb_build_array(jsonb_build_object('producto_id','$PROD','cantidad',1)),
  '[]'::jsonb, 0, 'VENTA AJENA TEST', NULL, NULL, NULL,
  md5('presupuesto:' || '$CHOQUE')::uuid);
SQL
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.convertir_presupuesto_en_venta('$CHOQUE'::uuid,'$CLI'::uuid,
  'FACTURA_B'::public.tipo_comprobante,'CTA_CTE'::public.condicion_venta,'[]'::jsonb, gen_random_uuid());
SQL
)
if echo "$out" | grep -qi "clave de este presupuesto"; then echo "  ✓ no se apropia de una venta ajena con la misma clave"; else echo "  ✗ se quedó con una venta ajena"; fallos=$((fallos+1)); fi
chequear "el presupuesto sigue abierto" "ABIERTO" \
  "$(q "select estado from public.presupuestos where id='$CHOQUE'")"

# crear_venta prelockea los productos por id: sin eso, dos cajas con los mismos
# productos en distinto orden se deadlockean.
chequear "crear_venta lockea los productos en orden" "true" \
  "$(q "select (position('ORDER BY p.id FOR UPDATE' in prosrc) > 0)::text from pg_proc where proname='crear_venta'")"
# El helper no puede quedar suelto: era un oráculo sobre presupuestos ajenos.
chequear "producto_tiene_presupuesto no es ejecutable por authenticated" "false" \
  "$(q "select has_function_privilege('authenticated','public.producto_tiene_presupuesto(uuid)','EXECUTE')::text")"

echo "── 10. Borrar un producto presupuestado ──────────────────"
# presupuesto_items tiene FK a productos: el producto caía en la rama del DELETE
# real y la excepción abortaba TODA la transacción — un borrado masivo de 50
# productos no borraba ninguno.
$PSQL > /dev/null <<SQL
INSERT INTO public.productos (codigo,nombre,precio_sin_iva,iva_porcentaje)
VALUES ('PRE-LIMPIO','PRODUCTO SIN HISTORIAL',1000,21)
ON CONFLICT (codigo) DO UPDATE SET archivado=false;
SQL
LIMPIO=$(q "select id::text from public.productos where codigo='PRE-LIMPIO'")
out=$($PSQL <<SQL 2>&1 || true
$(auth admin@local.test)
SELECT public.eliminar_productos(ARRAY['$PROD','$LIMPIO']::uuid[]);
SQL
)
if echo "$out" | grep -qi "violates foreign key"; then
  echo "  ✗ la FK del presupuesto abortó el borrado masivo"; fallos=$((fallos+1))
else
  echo "  ✓ el borrado masivo no revienta por la FK del presupuesto"
fi
chequear "el presupuestado se archivó (no se borró)" "true" \
  "$(q "select archivado::text from public.productos where id='$PROD'")"
chequear "el que no tenía historial sí se borró" "0" \
  "$(q "select count(*)::text from public.productos where codigo='PRE-LIMPIO'")"
$PSQL > /dev/null <<SQL
UPDATE public.productos SET archivado=false WHERE id='$PROD';
SQL

echo "── 11. Un empleado no ve los de otra sucursal ────────────"
otra=$(q "select count(*)::text from public.sucursales")
if [[ "$otra" -gt 1 ]]; then
  # psql entra como `postgres`, que SALTEA RLS: sin SET ROLE este check pasaba
  # aunque la RLS no existiera. Hay que ponerse el rol de la app.
  emp=$($PSQL -tAc "
$(auth empleado@local.test)
SET ROLE authenticated;
SELECT count(*) FROM public.presupuestos WHERE sucursal_id <> public.current_sucursal_id();" 2>&1 | tail -1)
  chequear "no ve presupuestos de otra sucursal" "0" "$emp"
  # Y que sí vea los suyos, para que el 0 de arriba no sea "no ve nada".
  propios=$($PSQL -tAc "
$(auth admin@local.test)
SET ROLE authenticated;
SELECT count(*) > 0 FROM public.presupuestos;" 2>&1 | tail -1)
  chequear "un admin sí los ve" "t" "$propios"
else
  echo "  · (una sola sucursal en la base local, se saltea)"
fi

echo "── Limpieza ──────────────────────────────────────────────"
$PSQL <<'SQL' > /dev/null
DELETE FROM public.presupuesto_items i USING public.presupuestos p
 WHERE p.id=i.presupuesto_id AND p.observaciones IS NOT DISTINCT FROM 'TEST-PRES';
DELETE FROM public.presupuestos WHERE observaciones IS NOT DISTINCT FROM 'TEST-PRES';
UPDATE public.productos SET precio_sin_iva = 10000 WHERE codigo='PRE-TEST';
SQL

if [[ $fallos -eq 0 ]]; then echo -e "\n✅ Todo verde.\n"; else echo -e "\n❌ $fallos fallo(s).\n"; exit 1; fi
