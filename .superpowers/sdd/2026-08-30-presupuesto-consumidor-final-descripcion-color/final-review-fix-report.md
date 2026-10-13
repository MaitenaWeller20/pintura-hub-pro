# Final review fix report — compatibilidad y fronteras cerradas

Fecha: 2026-08-30
Workspace: `/private/tmp/quimex-presupuesto-color.N9cBhs`
Base: `086def0`
Rango revisado: `1fea73d..086def0`
Re-review 2: `086def0..8e93423`
Re-review 3: `8e93423..40f3591`

## Resultado

Los cuatro hallazgos Important y los dos Minor de la revisión integral quedaron
resueltos en una sola ola coherente. El contrato moderno sigue exigiendo una
descripción normalizada, no vacía y de hasta 160 puntos de código, mientras los
nombres de catálogo y snapshots pre-release sin cambios permanecen operables y
se preservan byte a byte.

Las operaciones de crear/editar/convertir presupuesto cruzan ahora una frontera
servidora autenticada con entrada/salida estricta y un conjunto cerrado de
errores. La ambigüedad de transporte se reconoce por señales tipadas y acotadas;
no por mensajes amplios de negocio. El runbook describe el cutover incompatible
real con mantenimiento y drain, sin presentar como seguro un orden de despliegue
que no lo es.

## Compatibilidad de descripciones

- Cada línea de venta o presupuesto conserva el texto base autoritativo. Si el
  usuario no lo cambió, el payload omite `descripcion`, incluso si el valor
  histórico supera 160 puntos o normaliza a vacío.
- Si hay una edición real, el cliente normaliza y envía el valor; servidor y SQL
  vuelven a exigir 1..160 puntos de código.
- Venta directa y preview comparten un adaptador de payload. Alta/edición de
  presupuesto aplican el mismo criterio. Una NC vinculada omite la descripción
  cargada desde la factura.
- La ruta V2 de una NC total vinculada acepta el shape histórico del browser,
  descarta esos ítems y llama `anular_venta`; la descripción se copia desde DB y
  nunca se reintroduce texto legacy del cliente.
- La migración `20260830220345_preservar_descripciones_historicas_conversion.sql`
  crea la venta con productos/cantidades/precios autoritativos y copia en la
  misma transacción los snapshots exactos de `presupuesto_items`. Un mismatch de
  cardinalidad aborta venta, stock, caja y presupuesto.

### Cierre del segundo re-review

Una migración nueva, forward-only y posterior,
`20260830224905_identidad_items_hash_final_conversion_presupuesto.sql`, reemplaza
el emparejamiento físico de la primera solución. Cada UUID de
`presupuesto_items.id` se transforma en un marker interno único que atraviesa el
core owner-only; luego un UPDATE autoritativo marker→UUID copia la descripción
exacta y verifica producto, cantidad, precio neto y descuento final. La función
especializada tiene `search_path=''`, owner `postgres` y cero privilegios para
PUBLIC, `anon`, `authenticated` y `service_role`. Ninguna función de esta ruta
contiene `ctid`.

El writer calcula además la huella v1 con el mismo objeto y campos que
`crear_venta`, pero sobre los valores finales, incluida cada descripción
histórica exacta; los markers nunca llegan al hash durable. El lock y el chequeo
cerrado de la key ocurren antes de entrar al core. Por eso el replay público con
payload exacto recupera la venta, mientras una descripción cambiada u omitida
conflicta sin duplicar efectos.

## Transporte y retry

`esFalloTransporteAmbiguo` recorre como máximo seis niveles y evita ciclos.
Reconoce nombres/tipos AbortError y TimeoutError, mensajes exactos de
Chrome/Safari/undici/Firefox, códigos de red conocidos, causas anidadas y status
502/503/504. No usa coincidencias amplias que puedan confundir una validación o
un error de negocio.

Después de una respuesta posiblemente perdida se conservan juntos los bytes del
payload, la idempotency key y la acción original. Un resultado determinístico
descarta los tres y desbloquea la corrección.

## Fronteras de error

- Alta y edición dejaron de ejecutar RPCs de escritura desde el browser. Sus
  server functions validan autenticación, entrada y shape de salida, y conservan
  el cliente Supabase user-bound para que RLS siga siendo autoritativo.
- Conversión, alta y edición registran la causa cruda sólo en servidor. Al
  browser llega exclusivamente `{ ok: false, error: { codigo, mensaje } }` de un
  conjunto cerrado en español; nunca se serializan `cause`, constraints, tablas,
  funciones ni el mensaje de Supabase/Postgres.
- El diálogo decide por esos códigos seguros y por el clasificador local de
  transporte. No inspecciona substrings de base de datos.

## Evidencia TDD

| Ciclo                   | RED observado                                         | GREEN                      |
| ----------------------- | ----------------------------------------------------- | -------------------------- |
| Baseline + transporte   | 3 archivos; 4 fallos/10 pases                         | incluido en focal final    |
| Componentes montados    | 2 archivos; 9 fallos/36 pases                         | incluido en focal final    |
| Rutas                   | 3 archivos; 7 fallos/10 pases y una costura de import | 3 archivos/20 tests        |
| Frontera cerrada        | 2 archivos; 4 fallos/29 pases                         | resultados reales cerrados |
| Diálogo/códigos seguros | 1 archivo; 4 fallos/19 pases                          | 23/23 en ese ciclo         |
| Mapeo esperado          | 2 fallos/11                                           | 11/11                      |
| Mantenimiento cerrado   | 1 fallo/25                                            | 25/25 en ese ciclo         |
| Conversión SQL legacy   | error de límite 160 desde el core                     | snapshot exacto preservado |

Las pruebas de frontera inspeccionan recursivamente el resultado servidor real,
no sólo el texto del DOM. También prueban que una descripción custom de 161
puntos sigue rechazada.

## Matriz final

Ejecutada desde un reset local que aplicó todas las migraciones, incluida
`20260830224905`:

| Gate                                                     | Resultado                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `bash scripts/test-descripcion-personalizada-items.sh`   | PASS                                                       |
| `bash scripts/test-presupuesto-consumidor-final-caja.sh` | PASS                                                       |
| `bash scripts/test-editar-presupuesto.sh`                | PASS, 19/19                                                |
| `bash scripts/test-venta-fiscal-atomica.sh`              | PASS                                                       |
| `bash scripts/test-anulacion-fiscal-vinculada.sh`        | PASS                                                       |
| Focal de nueve archivos                                  | PASS, 119/119                                              |
| `npm test`                                               | PASS, 87 archivos/1834 tests; 2 archivos/22 tests omitidos |
| `npm run typecheck`                                      | PASS                                                       |
| `INVOICING_MOCK_MODE=true npm run build:vercel`          | PASS                                                       |
| `npm run e2e -- e2e/presupuestos-facturacion.spec.ts`    | PASS, 6/6                                                  |

El build conserva sólo warnings históricos ya inventariados: archivos de test
detectados por el router, usos anteriores de `inputValidator()` y módulos Node
externalizados. Las dos server functions nuevas usan `.validator()`.

## Rollout y decisión arquitectónica

No hay orden app-first o DB-first de cero downtime seguro sin un bridge probado:
la app anterior depende de snapshot/hash que revoca `20260830154723`, mientras
la nueva necesita los contratos finales de conversión y cola. Por eso el runbook
indica:

1. preflight de candidato, cajas y flags;
2. staging del artefacto final con `vercel deploy --prod --skip-domain`;
3. mantenimiento real y drain de requests, funciones, instancias y transacciones;
4. todas las migraciones pendientes en orden, incluida `20260830154723`;
5. promoción del artefacto staged;
6. smoke de ventas, cola, conversión, NC vinculada y PDF;
7. verificación de flags y reapertura.

Rollback es forward-only/fail-closed: mantener mantenimiento, V2 y legacy
apagados; no volver a una app incompatible; preservar evidencia e idempotencia;
reconciliar cualquier resultado ambiguo antes de reabrir.

Las migraciones `20260830220345` y `20260830224905` son un único lote de
mantenimiento: no debe circular tráfico entre ambas. No se intenta reconstruir
ni sobrescribir automáticamente el hash de una venta que hubiera sido creada en
ese estado intermedio no soportado; ante tal evidencia, el corte permanece
cerrado hasta reconciliarla.

## Evidencia adicional del segundo re-review

- RED: la aserción del hash final falló; la definición efectiva confirmó uso de
  `ctid` y ausencia del helper owner-only.
- GREEN: dos renglones del mismo producto, con cantidades, descuentos, importes
  y descripciones distintas, quedan asociados 1:1. Uno conserva más de 160
  puntos de código y el otro conserva whitespace que normaliza a vacío.
- El hash esperado se calcula en la prueba independientemente con el contrato
  público v1. Replay exacto recupera; descripción distinta y descripción
  omitida generan conflicto opaco.
- Conteos y saldos de venta, ítems, pagos, stock, caja, cuenta corriente y
  secuencias prueban que replay y conflictos no agregan ningún efecto.
- El guard de catálogo inspecciona ambas funciones efectivas y exige ausencia
  de `ctid`; el contrato custom de 161 puntos sigue rechazado por la suite de
  descripciones.
- La matriz final permaneció verde: cinco suites SQL tras reset, 87 archivos y
  1834 tests Vitest (2/22 omitidos), typecheck, build mock y E2E 6/6.

`supabase db advisors --local --type security --level warn --fail-on error` no
reportó el helper nuevo. El comando conserva dos errores históricos ajenos por
views security-definer (`fiscal_config_publica` y `cuenta_corriente_saldos`) y
warnings anteriores de search path, extensión y policies; no se amplió esta ola
acotada para alterar esas superficies.

## Auditoría y restricciones

La auditoría posterior al E2E encontró cero fixtures de presupuesto, productos,
clientes, usuarios Auth, perfiles, cajas y credenciales mock. Las secuencias
VENTA quedaron en conteo/suma `0/0`; flags en `false/false/false`; no quedó
listener en 8080. El stack Supabase local `gagrdirwlcunygtztiuk` se detuvo con
backup conservado.

No se usaron Supabase linked/remoto, `db push`, Vercel deploy, ARCA, certificados,
flags externos, push, rebase, amend ni force push.
