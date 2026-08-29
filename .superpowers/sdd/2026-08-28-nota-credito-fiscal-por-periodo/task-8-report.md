# Tarea 8 — efectos atómicos post-CAE de NC por período

Fecha: 2026-08-29

Base exacta: `a689f003298f432e78b9af6d5e5095c45504e7c0`

Commit funcional: `8275c26f07e80d2f583da1cb61f6db1c07cbb807` —
`feat(fiscal): aplicar efectos de NC después del CAE`

## Resultado

El lifecycle fiscal acepta snapshots persistidos v2/v3 y aplica los efectos
comerciales de una NC por período únicamente después de persistir el CAE. Tanto
`APROBAR` como `RECUPERAR_CAE` llaman al mismo helper owner-only dentro de la
misma transacción PostgreSQL. El lock de la venta, el marcador
`nc_efectos_aplicados_at`, los guards únicos duros y el CAS fiscal impiden
duplicados en replay y carreras reales.

Las NC vinculadas de reversión total continúan estrictamente en snapshot v2. Se
preservaron sus locks original→NC, leases, CAS, secuencias, FCE y writer fences.

## Archivos

- `supabase/migrations/20260829203941_efectos_nc_periodo_post_cae.sql`
  - creada con `supabase migration new efectos_nc_periodo_post_cae`;
  - agrega `aplicar_efectos_nc_periodo(uuid)`, owner `postgres`,
    `SECURITY DEFINER`, `search_path=''` y sin `EXECUTE` para roles API ni
    `service_role`;
  - agrega unicidad parcial por `(referencia_id, producto_id)` para movimientos
    `DEVOLUCION`;
  - recrea la definición efectiva extraída de `transicionar_emision_fiscal`,
    ampliándola sólo con permisos/flag, dispatch v2/v3, cancelación segura y las
    dos llamadas post-CAE;
  - permite que `PENDIENTE_FISCAL` atraviese el lifecycle fiscal sin relajar la
    intención comercial congelada.
- `scripts/test-nota-credito-periodo-fiscal.sh`
  - contrato lifecycle, efectos, rollback, permisos, flag, replay y
    concurrencia real.
- `scripts/test-venta-fiscal-atomica.sh`
  - regresión byte a byte de la reversión vinculada v2 y actualización de
    fixtures históricos para los fences/snapshots vigentes.
- `scripts/test-fiscal-concurrencia.sh`
  - actor fiscal autorizado explícito y metadata `SECURITY DEFINER` de la
    transición, conservando 180 aserciones de concurrencia.
- `scripts/test-liberar-claim-fiscal.sh`
  - fixture con admin efectivo para que la prueba alcance el contrato de
    liberación después de la nueva revalidación de permisos bajo lock.

No se modificaron migraciones históricas.

## TDD: RED / GREEN

Primero se extendió el contrato SQL. El RED real falló al intentar reclamar con
un empleado sin `puede_emitir_nc_periodo`: la transición anterior alcanzaba el
write y chocaba con `ventas_pendiente_fiscal_nc_periodo_check`, en vez de
rechazar por permiso. Evidencia: `/tmp/task8-red.log`.

Después se extrajo la función efectiva con `pg_get_functiondef` a
`/tmp/task8-transicionar-emision-fiscal.sql`, se generó la migración nueva y se
implementó el mínimo requerido. GREEN final desde reset limpio:

- contrato NC por período: 69 aserciones SQL y las dos pruebas de concurrencia
  reales pasan;
- venta fiscal atómica: 50 aserciones SQL y 3 carreras/regresiones de shell
  pasan;
- concurrencia fiscal: 180 OK, 0 fallas;
- carrera de dos `RECUPERAR_CAE`: un solo CAE persistido y un único vector de
  efectos.

## Matriz de efectos e idempotencia

| Estado / modalidad / resolución | Stock | Pagos / caja | Cuenta corriente | Estado comercial |
| --- | --- | --- | --- | --- |
| Creada, reclamada, reservada, request iniciado, respuesta, rechazo, error corregible o `RECONCILIAR` | Sin cambios | Sin cambios | Sin cambios | `PENDIENTE_FISCAL` |
| `DEVOLUCION_PRODUCTOS` aprobada/recuperada | Repone una vez en la sucursal; un `DEVOLUCION` único por producto/referencia | Según resolución | Según resolución | `ACTIVA`, marcador post-CAE |
| `BONIFICACION_AJUSTE` aprobada/recuperada | Sin stock ni movimientos; exige un único ítem `AJUSTE`, cantidad 1, lista=unitario, descuento 0 | Según resolución | Según resolución | `ACTIVA`, marcador post-CAE |
| `REINTEGRO` | Según modalidad | `venta_pagos` negativos, sesión abierta explícita, UUID planificado como `cobro_idempotency_key`; efectivo validado; sin inserción manual en `caja_movimientos` | Sin crédito | `total_pagado=total`, `PAGADO` |
| `SALDO_FAVOR` | Según modalidad | Sin pagos | Un `CREDITO CONFIRMADO` para el cliente comercial, incluso si difiere del receptor fiscal | `total_pagado=0`, `PENDIENTE` |
| Cancelación intacta | Sin cambios | Sin cambios; plan retenido como auditoría | Sin cambios | `ANULADA/CANCELADO` |
| Bloqueo, liberación, cancelación tocada o anulación de una NC aprobada | No aplica efectos; la operación insegura se rechaza | Sin cambios | Sin cambios | Sin estado parcial |

El helper bloquea la venta primero y retorna si el marcador ya existe. Los
productos y stocks se bloquean por UUID estable. Un fallo de stock, caja o
cuenta corriente revierte también la persistencia local del CAE: la fila queda
reconciliable, nunca medio aprobada. Los replays de aprobación/recuperación y
las carreras no duplican stock, pagos, caja ni cuenta corriente.

## Permisos, flag y snapshots

- Para NC por período, la transición revalida bajo lock
  `puede_emitir_nc_periodo`; esa función exige perfil activo, `puede_facturar` y
  `puede_emitir_nc_periodo`, salvo admin efectivo.
- Una llamada con JWT usa al actor real. El worker `service_role` sin `sub` usa
  el `usuario_id` persistido de la venta bloqueada, compatible con el emisor
  server existente sin confiar en la UI.
- Con el flag apagado se bloquean reclamo/reserva/request/reenvío frescos; se
  permiten respuesta, aprobación, conciliación, recuperación, bloqueo,
  liberación y cancelación segura de trabajo ya iniciado.
- `RESERVAR` usa `validar_snapshot_fiscal_persistido` y guarda la versión real.
  Request, aprobación y recuperación comparan la versión del intento con
  `snapshot.version`. La validación del original vinculado sigue v2-only.
- La regresión vinculada verifica snapshot original byte a byte, hash y vector
  comercial sin cambios.

## Verificación

- `supabase db reset`: OK; aplicó la migración nueva desde cero.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: OK.
- `bash scripts/test-venta-fiscal-atomica.sh`: OK.
- `bash scripts/test-fiscal-concurrencia.sh`: 180 OK, 0 fallas.
- `bash scripts/test-anulacion-fiscal-vinculada.sh`: OK.
- `bash scripts/test-anulacion-interna-idempotente.sh`: OK.
- `bash scripts/test-liberar-claim-fiscal.sh`: 9 OK, 0 fallas.
- `bash scripts/test-nota-credito-periodo-schema.sh`: OK.
- `bash scripts/test-snapshot-fiscal-v3.sh`: contrato v3 OK.
- `npm test`: 73 archivos pasados, 2 omitidos; 1539 pruebas pasadas y 22
  omitidas.
- `npm run typecheck`: OK.
- `bash -n` sobre los cuatro scripts modificados: OK.
- `git diff --check`: OK.
- Catálogo: helper owner-only sin grants API; transición sólo ejecutable por
  `service_role`; dos llamadas al helper; índice parcial único instalado.

## Basales separados

- `npm run lint` global conserva 4271 hallazgos (4262 errores y 9 warnings) en
  TypeScript preexistente, fuera de este diff SQL/bash. No se tocó TypeScript.
- `supabase db lint --level warning` termina correctamente pero informa el error
  histórico de `public.cambiar_precios_masivo`: relación temporal `_objetivo`
  ausente. No señala funciones de esta tarea.
- `scripts/test-notas-v2-scope.sh` es basal incompatible con el retiro vigente
  del writer legacy: intenta insertar una `FACTURA_A` por esa vía y luego exige
  reactivar `facturacion_legacy_writer_enabled=true`, prohibido por
  `ck_settings_legacy_writer_retirado`. Se conservó el contrato productivo y no
  se falseó esa regresión obsoleta.
- Al inicio, `scripts/test-venta-fiscal-atomica.sh` también contenía fixtures
  históricos que reactivaban el writer retirado y snapshots sintéticos ya
  inválidos. Se actualizaron sólo sus fixtures para atravesar fences actuales,
  manteniendo las aserciones de lifecycle.

## Decisiones y riesgos

- La transición pasó a `SECURITY DEFINER` porque el helper deliberadamente no
  es ejecutable por `service_role`; su ACL externa sigue limitada a ese único
  rol y toda autorización se revalida dentro de la función.
- El helper compara snapshot v3, hash, venta, fecha, sucursal, emisor,
  identidad, período, modalidad, motivo, totales e ítems contra las filas
  persistidas antes de producir efectos. No repricia ni consulta `activo` para
  decidir una devolución.
- Un reintegro requiere una sesión abierta y, para efectivo, fondos disponibles
  en el momento de cerrar localmente el CAE. Si no se cumplen, la transacción
  local revierte y debe resolverse por conciliación/recuperación; ARCA nunca se
  reintenta a ciegas.
- El índice parcial nuevo presupone que no existen previamente devoluciones
  duplicadas por venta/producto. El reset local y toda la suite pasan; antes de
  un despliegue futuro conviene auditar datos productivos, fuera del alcance de
  esta tarea.
- No se llamó ARCA real, no se tocaron server action, UI, PDF, certificados,
  deploy, push ni producción.

## Fix round 1 — plan inmutable y evidencia CAE vinculante

Fecha: 2026-08-29

HEAD de partida del fix: `a1ef351391d3b66aef704f4dc634d0d469f57534`.

Commit funcional del fix: `9b3871a` —
`fix(fiscal): inmovilizar plan y evidencia CAE`.

### Resultado del fix

Se cerraron los dos hallazgos de revisión:

1. El plan de reintegros ya no admite DML desde `service_role` ni desde roles
   API. Un trigger `SECURITY INVOKER` toma el mismo advisory lock que el
   materializador y sólo acepta al owner real de la tabla. La creación sigue
   ocurriendo dentro de la RPC owner.
2. `APROBAR` y `RECUPERAR_CAE` comparten
   `validar_evidencia_cae_fiscal`. Antes de escribir exigen CAE de exactamente
   14 dígitos, fecha canónica y válida, timestamp UTC canónico y finito cuando
   corresponde, resultado externo aprobatorio y coincidencia exacta entre la
   evidencia persistida y los parámetros.

`materializar_intencion_nc_periodo` bloquea la venta y el plan, ordena y
materializa una sola vez el vector con sus UUID planificados y reconstruye el
payload canónico completo de Tarea 4: actor, sucursal, cliente, modalidad,
período, motivo, resolución, ítems y reintegros con las mismas escalas y orden.
El SHA-256 se compara bajo lock con `ventas.nc_periodo_payload_hash`. El helper
post-CAE usa exclusivamente ese vector para validar caja e insertar
`venta_pagos`; no vuelve a leer la tabla del plan.

El runtime TypeScript persiste CAE, vencimiento y el mismo `emitido_at` dentro
de `RESPUESTA_RECIBIDA`, y la recuperación incluye el CAE consultado y su
vencimiento en la evidencia exacta. No se inventa ningún CAE durante la
recuperación.

### TDD real: RED y GREEN

RED se capturó antes de la implementación:

- `/tmp/task8-fix1-red-sql.log`: `SET ROLE service_role` logró insertar una
  fila del plan; el contrato falló con `operación fue aceptada`.
- `/tmp/task8-fix1-red-ts.log`: dos pruebas fallaron porque los resúmenes de
  aprobación y recuperación no incluían CAE/vencimiento/timestamp vinculantes.

GREEN después de la migración nueva
`20260829213501_cerrar_plan_y_evidencia_cae_nc_periodo.sql`:

- los ataques `INSERT`, `UPDATE` y `DELETE` como `service_role` fallan;
- una mutación owner que conserva el total pero cambia medio/monto produce
  mismatch del hash y rollback de CAE, stock, pagos, caja, cuenta corriente y
  marcador;
- CAE corto, no numérico, fecha no canónica/inexistente, timestamp inválido,
  parámetros distintos de la evidencia y respuesta `R` confirmada fallan sin
  cambio parcial;
- aprobación y recuperación válidas siguen aplicando exactamente una vez el
  mismo helper y el mismo vector comercial.

### Matriz de ataque, replay y concurrencia

| Escenario | Resultado | Efectos comerciales |
| --- | --- | --- |
| DML directo de `service_role` sobre el plan | `permission denied` por ACL; guard owner-only como segunda barrera | Ninguno |
| Mutación owner del vector antes de `APROBAR` | Hash canónico distinto; transacción abortada | CAE, stock, pagos, caja, CC y marcador intactos |
| Dos `RECUPERAR_CAE` concurrentes | Un solo ganador por locks/CAS | Un movimiento de stock, un pago con UUID planificado y un marcador |
| Mutación `service_role` concurrente con ambas recuperaciones | Rechazada mientras compiten las tres conexiones reales | El pago conserva medio, monto y UUID originales |
| Replay de `APROBAR` o `RECUPERAR_CAE` | Rechazado por versión/token/estado ya consumido | Sin duplicados |
| Evidencia `R`, ausente, divergente o CAE/fecha/timestamp inválidos | Rechazo previo a escritura | Sin CAE ni efectos |
| Evidencia `A` exacta | Persiste CAE y llama al helper en la misma transacción | Matriz original de devolución/ajuste/reintegro/saldo conservada |

### Archivos del fix

- `supabase/migrations/20260829213501_cerrar_plan_y_evidencia_cae_nc_periodo.sql`
  — creada con `supabase migration new cerrar_plan_y_evidencia_cae_nc_periodo`;
  ACL/guard del plan, materialización canónica, helper post-CAE sin segunda
  lectura, validador compartido de evidencia y wrapper del lifecycle.
- `src/lib/fiscal/emision.ts` y `src/lib/fiscal/emision.test.ts` — evidencia
  completa y timestamp único para respuesta/aprobación; CAE consultado en
  recuperación.
- `scripts/test-nota-credito-periodo-fiscal.sh` — ataques, rollback, CAE
  negativo y carrera real de tres conexiones.
- `scripts/test-fiscal-concurrencia.sh`,
  `scripts/test-venta-fiscal-atomica.sh` y
  `scripts/test-conflictos-emision-rest.sh` — fixtures aprobatorios vinculados
  al CAE real y preservación de lifecycle/locks/CAS/REST.
- `scripts/test-nota-credito-periodo-schema.sh` — contrato actualizado a
  `service_role` de sólo lectura sobre el plan.

No se modificó ninguna migración histórica.

### Verificación del fix

- `supabase db reset --local`: OK desde cero con la migración nueva.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: OK; 84 aserciones SQL y
  dos verificaciones de shell/concurrencia reales.
- `bash scripts/test-fiscal-concurrencia.sh`: 180 OK, 0 fallas.
- `bash scripts/test-venta-fiscal-atomica.sh`: contrato completo y tres
  carreras de shell en verde.
- `bash scripts/test-conflictos-emision-rest.sh`: 42 verificaciones REST y de
  locks reales en verde; cero requests ARCA.
- `bash scripts/test-anulacion-fiscal-vinculada.sh`: OK.
- `bash scripts/test-anulacion-interna-idempotente.sh`: OK.
- `bash scripts/test-liberar-claim-fiscal.sh`: 9 OK, 0 fallas.
- `bash scripts/test-nota-credito-periodo-schema.sh`: OK.
- `bash scripts/test-snapshot-fiscal-v3.sh`: OK.
- `npm test`: 73 archivos pasados, 2 omitidos; 1539 pruebas pasadas y 22
  omitidas.
- `npm run typecheck`: OK.
- `npx eslint src/lib/fiscal/emision.ts src/lib/fiscal/emision.test.ts`: OK.
- `bash -n` en todos los scripts modificados: OK.
- `git diff --check`: OK.

### Basales y riesgos del fix

- `supabase db lint --local --level warning` finaliza e informa únicamente el
  error histórico de `public.cambiar_precios_masivo` por la relación temporal
  `_objetivo`; no marca funciones del fix.
- `scripts/test-nota-credito-sin-factura.sh` conserva 20 fallas en cascada: su
  primer caso intenta crear una NC por el writer genérico retirado y recibe la
  barrera histórica `La nota de crédito v2 se crea exclusivamente mediante
  anular_venta`. Es un contrato obsoleto previo a esta tarea; no se relajó el
  writer fence para falsearlo.
- El guard permite DML únicamente al owner PostgreSQL para que las RPC puedan
  crear la intención. Una corrupción privilegiada sigue siendo detectable por
  el hash antes de efectos, como prueba el fixture owner; proteger a un
  superusuario de sí mismo queda fuera del modelo de privilegios PostgreSQL.
- El wrapper de transición conserva el core previo sin reescribir sus ramas:
  sólo intercepta respuesta/aprobación/recuperación para vincular evidencia.
  Sus locks mantienen el orden original→NC→intento y el core conserva leases,
  CAS, FCE, secuencias y writer fences.
- No se llamó ARCA real ni se tocaron server action, UI, PDF, certificados,
  deploy, push o producción.
