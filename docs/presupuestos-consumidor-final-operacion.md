# Presupuestos a Consumidor Final: operación y rollout

## Alcance

La conversión permite que un presupuesto sin ficha de cliente cree una venta de contado contra el único cliente genérico global. El presupuesto conserva `cliente_id = NULL`; la venta guarda el cliente efectivo devuelto por el servidor. La sucursal, la caja, los ítems, el pago, el stock y la vinculación del presupuesto se confirman en una única operación idempotente.

Esta función comercial no autoabre cajas. Si la sucursal del presupuesto no tiene exactamente una caja abierta, la conversión se bloquea y el operador debe abrirla por el circuito normal de Caja. El escritor fiscal legacy sigue retirado y no debe reactivarse como rollback.

La conversión tampoco cambia la identidad fiscal del emisor. No hace falta crear, copiar ni renovar ningún certificado ARCA adicional para habilitarla. Si después se factura la venta, se usa la configuración fiscal que ya corresponde a su sucursal.

## Preflight antes del rollout

Ejecutar las consultas con un rol operativo autorizado. No corregir datos automáticamente desde un deploy.

### Único Consumidor Final global

Debe devolver exactamente una fila:

```sql
SELECT id, razon_social, tipo, activo, es_generico,
       sucursal_habitual_id, COALESCE(es_obra, false) AS es_obra
  FROM public.clientes
 WHERE activo
   AND es_generico
   AND tipo = 'CONSUMIDOR_FINAL'
   AND sucursal_habitual_id IS NULL
   AND NOT COALESCE(es_obra, false)
 ORDER BY id;
```

Este control de cardinalidad también ocurre dentro de la RPC. Cero o más de un candidato dejan la operación cerrada sin mutaciones.

### Cajas abiertas por sucursal

La consulta muestra todas las sucursales activas y permite detectar cardinalidad cero o mayor que uno:

```sql
SELECT s.id AS sucursal_id,
       s.nombre AS sucursal,
       count(cs.id) AS cajas_abiertas,
       array_agg(cs.id ORDER BY cs.abierta_en DESC, cs.id)
         FILTER (WHERE cs.id IS NOT NULL) AS caja_ids,
       max(cs.abierta_en) AS abierta_desde
  FROM public.sucursales AS s
  LEFT JOIN public.caja_sesiones AS cs
    ON cs.sucursal_id = s.id
   AND cs.estado = 'ABIERTA'
 WHERE s.activa
 GROUP BY s.id, s.nombre
 ORDER BY s.nombre;
```

Para convertir un presupuesto, su sucursal debe mostrar `cajas_abiertas = 1`. La interfaz presenta esa sucursal y `abierta_desde`; nunca abre una sesión por su cuenta.

### Flags y retiro legacy

```sql
SELECT facturacion_receptor_v2_enabled,
       facturacion_legacy_writer_enabled
  FROM public.settings
 WHERE id = true;

SELECT
  pg_catalog.to_regprocedure(
    'public.convertir_presupuesto_en_venta(uuid,uuid,public.tipo_comprobante,public.condicion_venta,jsonb,uuid)'
  ) IS NULL AS escritor_legacy_retirado,
  NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.next_comprobante_numero(uuid,public.tipo_comprobante)',
    'EXECUTE'
  ) AS helper_legacy_no_ejecutable;
```

El estado habilitado esperado es V2 `true`, legacy `false`, firma legacy ausente y helper legacy no ejecutable.

## Rollout

Este release exige un corte de mantenimiento. No existe un orden de despliegue
zero-downtime seguro sin un puente de compatibilidad adicional: la aplicación
anterior lee campos de snapshot/hash cuyo acceso revoca
`20260830154723_cerrar_acl_ventas_y_proyeccion_cola_fiscal.sql`, mientras la
aplicación nueva requiere los contratos finales de conversión y proyección de
cola que todavía no existen antes de las migraciones. Aplicar base primero
rompe instancias anteriores; promover aplicación primero rompe instancias
nuevas. Este release no incorpora ni presume ese puente.

La secuencia operativa es:

1. Ejecutar la matriz SQL y de aplicación en una instancia local reiniciada.
   Repetir las historias en homologación con caja abierta por el circuito
   normal y ARCA en modo de prueba; no usar certificados ni endpoints reales
   para la prueba automatizada.
2. En producción y todavía sin mutar esquema, ejecutar los preflight de este
   documento: confirmar exactamente un Consumidor Final global elegible,
   revisar la cardinalidad de cajas de cada sucursal candidata y registrar el
   estado de flags, cola, versión de aplicación y migraciones pendientes.
3. Construir el artefacto final como deployment de producción sin asignarle el
   dominio, guardar su URL inmutable y SHA, y probar su healthcheck aislado:

   ```bash
   vercel deploy --prod --skip-domain
   ```

   No promover todavía ese deployment.

4. Activar un mantenimiento real que impida **todas** las nuevas escrituras
   comerciales, no sólo los botones fiscales. Poner ambos escritores en
   `false`, registrar la duración máxima de requests/functions/transacciones y
   esperar al menos ese período. Verificar que no queden requests,
   transacciones ni instancias anteriores atendiendo trabajo. Los flags son
   defensa fail-closed, no sustituyen el bloqueo de tráfico ni el drenaje.
5. Con mantenimiento activo, aplicar **todas** las migraciones pendientes en
   orden y verificar esquema y ledger después de cada una. El lote debe incluir
   `20260830154723_cerrar_acl_ventas_y_proyeccion_cola_fiscal.sql` y
   `20260830220345_preservar_descripciones_historicas_conversion.sql`, además de
   `20260830224905_identidad_items_hash_final_conversion_presupuesto.sql` y
   cualquier versión anterior pendiente. Las dos últimas forman un único cambio
   de contrato: no se permite tráfico comercial entre ellas. Un hash,
   postcondición o ledger inesperado aborta el corte; nunca se salta ni se marca
   manualmente una migración sin comprobar su SQL efectivo.
6. Promover exactamente la URL inmutable preparada en el paso 3, sin hacer un
   build nuevo durante el corte:

   ```bash
   vercel promote <deployment-production-url>
   ```

   Mantener el bloqueo mientras arrancan las instancias nuevas y comprobar de
   nuevo que ninguna instancia anterior sigue sirviendo requests.

7. Habilitar exclusivamente V2 dentro de una transacción y verificar el
   resultado:

```sql
BEGIN;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quimex:facturacion:v2-cutover', 0)
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled = true,
       facturacion_legacy_writer_enabled = false
 WHERE id = true;

SELECT facturacion_receptor_v2_enabled,
       facturacion_legacy_writer_enabled
  FROM public.settings
 WHERE id = true;

COMMIT;
```

8. Todavía en mantenimiento, ejecutar smoke controlado de: listado de ventas,
   proyección/cola fiscal, conversión de presupuesto, NC total vinculada y PDF.
   En la conversión revisar presupuesto, venta, pago, stock, caja, receptor y
   descripción congelada. No reintentar a ciegas una respuesta incierta.
9. Volver a leer flags y exigir `v2=true`, `legacy=false`; revisar errores y
   cola, confirmar el drenaje final y recién entonces reabrir el tráfico.

Si cualquier paso falla después de aplicar las migraciones, no promover la
aplicación anterior: ya no es compatible con el esquema post-corte. Mantener el
mantenimiento y ambos flags en `false`, preservar ventas, snapshots, hashes,
cola e idempotency keys, y corregir hacia adelante. Sólo se puede promover otro
artefacto si se demuestra compatible con el esquema ya instalado. Un resultado
comercial o fiscal ambiguo se concilia antes de repetirlo. Si la auditoría
detectara que hubo una conversión entre `20260830220345` y `20260830224905`, no
reescribir su huella automáticamente: mantener cerrado, conservar la evidencia
y reconciliar esa venta antes de avanzar.

## Verificación de una conversión

Reemplazar el UUID de ejemplo por el presupuesto auditado:

```sql
SELECT p.id AS presupuesto_id,
       p.estado,
       p.cliente_id AS cliente_presupuesto,
       p.venta_id,
       p.conversion_payload_hash,
       v.cliente_id AS cliente_venta,
       v.sucursal_id,
       v.caja_sesion_id,
       v.condicion_venta,
       v.numero_comprobante,
       v.afip_estado
  FROM public.presupuestos AS p
  LEFT JOIN public.ventas AS v ON v.id = p.venta_id
 WHERE p.id = '00000000-0000-0000-0000-000000000000'::uuid;
```

Para un anónimo convertido se espera `cliente_presupuesto IS NULL`, `cliente_venta` igual al genérico global, `condicion_venta = 'CONTADO'`, caja no nula y un hash SHA-256 de 64 caracteres.

La siguiente comparación debe devolver dos arreglos iguales. Incluye la descripción personalizada congelada, no el nombre actual del producto:

```sql
WITH elegido AS (
  SELECT id, venta_id
    FROM public.presupuestos
   WHERE id = '00000000-0000-0000-0000-000000000000'::uuid
),
lineas_presupuesto AS (
  SELECT jsonb_agg(
           jsonb_build_object(
             'codigo', i.codigo,
             'descripcion', i.descripcion,
             'cantidad', i.cantidad,
             'precio_sin_iva', i.precio_sin_iva,
             'iva_porcentaje', i.iva_porcentaje
           ) ORDER BY i.codigo, i.descripcion, i.cantidad, i.precio_sin_iva
         ) AS lineas
    FROM elegido AS e
    JOIN public.presupuesto_items AS i ON i.presupuesto_id = e.id
),
lineas_venta AS (
  SELECT jsonb_agg(
           jsonb_build_object(
             'codigo', i.codigo,
             'descripcion', i.descripcion,
             'cantidad', i.cantidad,
             'precio_sin_iva', i.precio_unitario_sin_iva,
             'iva_porcentaje', i.iva_porcentaje
           ) ORDER BY i.codigo, i.descripcion, i.cantidad, i.precio_unitario_sin_iva
         ) AS lineas
    FROM elegido AS e
    JOIN public.venta_items AS i ON i.venta_id = e.venta_id
)
SELECT p.lineas AS presupuesto, v.lineas AS venta,
       p.lineas = v.lineas AS descripcion_y_lineas_congeladas
  FROM lineas_presupuesto AS p
 CROSS JOIN lineas_venta AS v;
```

Complementar con efectos únicos:

```sql
SELECT v.id AS venta_id,
       count(DISTINCT vp.id) AS pagos,
       count(DISTINCT sm.id) AS movimientos_stock,
       count(DISTINCT ccm.id) AS movimientos_cuenta_corriente
  FROM public.presupuestos AS p
  JOIN public.ventas AS v ON v.id = p.venta_id
  LEFT JOIN public.venta_pagos AS vp ON vp.venta_id = v.id
  LEFT JOIN public.stock_movimientos AS sm ON sm.referencia_id = v.id
  LEFT JOIN public.cuenta_corriente_movimientos AS ccm ON ccm.venta_id = v.id
 WHERE p.id = '00000000-0000-0000-0000-000000000000'::uuid
 GROUP BY v.id;
```

## Rollback operativo

Ante una anomalía, detener nuevas conversiones de forma fail-closed. Esto no deshace ventas confirmadas ni intenta reemitir comprobantes:

```sql
BEGIN;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('quimex:facturacion:v2-cutover', 0)
);

UPDATE public.settings
   SET facturacion_receptor_v2_enabled = false,
       facturacion_legacy_writer_enabled = false
 WHERE id = true;

SELECT facturacion_receptor_v2_enabled,
       facturacion_legacy_writer_enabled
  FROM public.settings
 WHERE id = true;

COMMIT;
```

Con ambos flags en `false`, la aplicación queda en mantenimiento. No restaurar la función legacy, no poner `facturacion_legacy_writer_enabled = true` y no borrar columnas, hashes, ventas, pagos, stock ni snapshots fiscales. Auditar las operaciones ya confirmadas por `presupuestos.venta_id` e `idempotency_key`; después de corregir y verificar, volver a habilitar sólo V2 con el bloque de rollout.
