# Task 7 report — snapshot fiscal v2 canónico e inmutable

## Base y alcance

- Base exacta: `28b86c4091c4eca91bfe89b4e2e915b67d54cadc`.
- Worktree aislado: `/tmp/quimex-integracion.FB906f/tree`.
- Migración forward creada exclusivamente con
  `supabase migration new snapshot_fiscal_v2_completo`:
  `supabase/migrations/20260822203901_snapshot_fiscal_v2_completo.sql`.
- No se editaron migraciones históricas ni se hizo red a ARCA, deploy, push,
  migración remota o cambio de flags.
- Se preservaron sin cambiar semántica `crearSnapshotFiscal` v1,
  `identidadReservaCoincide`, `resolverReceptorFiscalLegacy` y sus callers/tests.

## TDD: RED y GREEN

El RED focal se materializó antes de la implementación. La primera ejecución
tuvo 8 fallas por las APIs v2 ausentes, con las 36 pruebas legacy todavía
verdes. Después de ampliar la matriz fail-closed, el RED tuvo 9 fallas. Incluyó:

- shape completo y fixture compartido TypeScript/PostgreSQL;
- orden canónico de objetos y arrays de dominio;
- vectores SHA-256 `""`, `"abc"` y Unicode UTF-8;
- claves desconocidas/faltantes en raíz y objetos anidados;
- decimales JSON numéricos, filas IVA/tributos en cero, duplicados y desorden;
- coherencia emisor/receptor/identidad/letra/tipo/modo/validez;
- bloqueo de C nuevo para el rollout RI A/B;
- factura versus NC, asociación completa con CUIT y hash alterado;
- alícuotas vacías sólo en comprobante puramente exento/no gravado.

GREEN focal final:

```text
npm test -- src/lib/fiscal/snapshot.test.ts
Test Files  1 passed (1)
Tests       57 passed (57)
```

### Corrección de review 1/5

Sobre la base exacta `82aaebc7d36b6e8bafd2045c5eb399854c117441` se
reprodujeron independientemente los cuatro hallazgos confirmados. El RED focal
de TypeScript quedó en `63 passed / 10 failed`; el contrato PostgreSQL aceptó
indebidamente cinco casos equivalentes. El contrato atómico también demostró
que una NC podía reservarse con ítems distintos del original.

El GREEN posterior agrega:

- recálculo por línea en aritmética fija desde cantidad, precio unitario neto,
  descuento e IVA, con redondeo half-up por ítem antes de sumar;
- mapeo exacto de tasa a ID ARCA y comparación exacta de cada grupo ya
  redondeado, incluida la regla agregada inequívoca para IVA 0%/ID 3;
- herencia byte-a-byte de `items` para NC, probada con descripción y cambios
  aritméticamente válidos de cantidad/precio/descuento/tasa;
- arrays con prototipo estándar e índices data/enumerables propios: se
  rechazan accessors sin ejecutarlos, setters, índices no enumerables, huecos,
  extras, símbolos y prototipos custom;
- instantes UTC canónicos con segundos o exactamente tres milisegundos, sin
  aceptar normalizaciones de fechas imposibles ni `24:00`.

GREEN focal final de esta ronda:

```text
npx vitest run src/lib/fiscal/snapshot.test.ts
Test Files  1 passed (1)
Tests       74 passed (74)
```

## Implementación TypeScript

`SnapshotFiscalV2` congela venta, ítems, emisor, sucursal, receptor lógico y
ARCA, identidad reservada, letra/tipo/concepto, fecha, desglose de importes,
alícuotas, tributos, moneda/cotización, campos de transparencia y asociación.
`SnapshotFiscalV2Input` omite tanto `hash` como `version`; el constructor agrega
internamente `version: 2`, normaliza/clona, valida, calcula el hash y devuelve un
objeto profundamente congelado.

La serialización:

- ordena claves por bytes UTF-8 y no por locale;
- ordena ítems por UUID, IVA por id numérico, tributos por tupla completa y
  asociaciones por tipo/PV/número/CUIT/fecha;
- rechaza ciclos, accessors, `Date`, arrays dispersos o con propiedades extra,
  `undefined`, funciones, símbolos, bigint, enteros inseguros/no enteros,
  `NaN`, infinito, `-0` y surrogates UTF-16 no emparejados;
- usa un SHA-256 síncrono puro TypeScript y browser-safe, sin `node:crypto`,
  WebCrypto asíncrono ni dependencia transitiva.

La validación recomputa el hash y falla cerrada ante cualquier diferencia. Las
cuentas se hacen en centavos enteros: cada línea se recalcula desde sus cuatro
operandos y recién entonces se agrupa por el ID ARCA exacto. Valida desglose de
ítems, IVA, tributos y cabecera, además de fechas/instantes canónicos, CUIT,
documentos, condición/id ARCA, asociación y la matriz RI A/B. No existe upgrade
silencioso de v1.

El fixture compartido quedó en
`test/fixtures/fiscal-snapshot-parity-v2.json`. Su serialización canónica tiene
SHA-256:

```text
654e81eef4b7d1673eeabf7b6ffeb1e147a230f151cff7211f2e095134e4d705
```

## Migración forward y paridad SQL

La nueva función `public.validar_snapshot_fiscal_v2(jsonb)` replica el contrato
fail-closed en PostgreSQL: allowlists exactos anidados, tipos/rangos, decimales,
fechas, checksum CUIT, documentos y condición del receptor, matriz A/B,
aritmética de ítems/cabecera/IVA/tributos, orden, duplicados y reglas factura/NC.
Recalcula el hash con el serializador canónico de Task 3. Es `SECURITY INVOKER`,
tiene `search_path=''` y ejecución exclusiva de `service_role`.

La implementación efectiva de `transicionar_emision_fiscal` se copió
mecánicamente desde el bloque completo de
`20260822161644_venta_fiscal_atomica.sql` (líneas 709–1851) antes de adaptarla.
La comparación usada fue:

```sh
diff -u \
  <(sed -n '709,1851p' supabase/migrations/20260822161644_venta_fiscal_atomica.sql) \
  <(sed -n '/^CREATE OR REPLACE FUNCTION public.transicionar_emision_fiscal(/,/^  TO service_role;$/p' \
    supabase/migrations/20260822203901_snapshot_fiscal_v2_completo.sql)
```

El diff mecánico contiene sólo estos cambios deliberados:

1. La identidad acepta, tipa y compara `validez`.
2. `RESERVAR` llama al validador v2 completo antes de persistir y verifica que
   `importeTotal` sea la magnitud de la venta.
3. Para NC, el snapshot original también se valida completo y se le recalcula
   el hash bajo las mismas reglas.
4. La NC hereda exactamente emisor, sucursal, receptor, `items`, letra/concepto,
   moneda/cotización, modo/validez y cada importe positivo de cabecera, IVA y
   tributos; sólo cambian identidad/tipo/fecha permitidos.
5. `CbtesAsoc` exige las claves exactas y el CUIT del comprobante original.

Se conservaron la firma única, `SECURITY INVOKER`, `search_path`, grants,
acciones, locks, estados, carrera original→NC y todos los hardenings de Task 4.
No se agregó nota de débito ni motor de emisión/impresión.

## Contratos SQL y scripts

- `test-fiscal-concurrencia.sh` construye snapshots v2 completos desde el
  fixture, usa CUITs sintéticos con checksum válido y prueba paridad/hash,
  privilegios, anidados, decimales, duplicados, orden, modo/validez, cálculo
  fijo por línea, agrupación IVA/ID 3 e instantes canónicos.
- `test-venta-fiscal-atomica.sh` deriva la NC completa exclusivamente desde el
  snapshot original, incluye CUIT en `CbtesAsoc` y prueba rechazo de toda
  divergencia de herencia, además de las carreras ya existentes.
- Los scripts históricos de multiemisor, contado, NC interna y caja ahora
  resuelven el nombre del contenedor desde `supabase/config.toml`; contado y NC
  interna crean de forma determinista su admin local después de un reset. Estos
  cambios de harness fueron necesarios para ejecutar literalmente la matriz
  requerida en este worktree, cuyo contenedor no se llama
  `supabase_db_local`; no cambian lógica productiva.

## Verificación final fresca

Ejecutada después del último cambio:

- `supabase db reset --debug`: PASS; aplicó toda la historia y la migración
  `20260822203901` desde cero. Un intento previo sin `--debug` falló durante la
  recreación del contenedor, antes de migraciones; la repetición detallada
  estabilizó healthchecks y no mostró error SQL.
- `./scripts/test-receptor-fiscal-schema.sh`: PASS.
- `./scripts/test-fiscal-concurrencia.sh`: PASS, `131 ok / 0 fallas`.
- `./scripts/test-venta-fiscal-atomica.sh`: PASS, incluidas carreras reales.
- `./scripts/test-facturacion-multiemisor.sh`: PASS.
- `./scripts/test-venta-contado.sh`: PASS.
- `./scripts/test-nota-credito-sin-factura.sh`: PASS.
- `./scripts/test-caja-y-saldos.sh`: PASS, `28 ok / 0 fallas`.
- `npm test`: PASS, 30 archivos; 584 tests aprobados y 4 omitidos.
- `npm run typecheck`: PASS.
- `INVOICING_MOCK_MODE=true npm run build:vercel`: PASS; sólo warnings
  preexistentes de `inputValidator`, plugin de paths y tamaño de chunks.
- `supabase db lint --level warning`: exit 0 y ningún finding de Task 7.
  Persisten dos hallazgos históricos ajenos: `_objetivo` en
  `cambiar_precios_masivo` y `p_idempotency_key` sin uso en
  `convertir_presupuesto_en_venta`.
- `git diff --check`: PASS.
- La migración histórica `20260822161644_venta_fiscal_atomica.sql` no tiene
  diff.

## Archivos

Archivos de alcance directo:

- `src/lib/fiscal/snapshot.ts`
- `src/lib/fiscal/snapshot.test.ts`
- `test/fixtures/fiscal-snapshot-parity-v2.json`
- `scripts/test-fiscal-concurrencia.sh`
- `scripts/test-venta-fiscal-atomica.sh`
- `supabase/migrations/20260822203901_snapshot_fiscal_v2_completo.sql`

Harnesses adicionales justificados arriba:

- `scripts/test-facturacion-multiemisor.sh`
- `scripts/test-venta-contado.sh`
- `scripts/test-nota-credito-sin-factura.sh`
- `scripts/test-caja-y-saldos.sh`

Commit solicitado: `feat(fiscal): congelar snapshot fiscal v2`.

## Riesgos / continuidad

Task 7 deja construido y validado el dato inmutable; no conecta todavía el
motor nuevo de Task 9 ni modifica impresión. El caller de Task 9 debe construir
exactamente este shape y las NC exclusivamente desde el snapshot original. Los
dos findings históricos del lint permanecen fuera de alcance y sin cambios.

## Fix round 2/5 — fechas y CUIT canónicos

Se cerraron los dos hallazgos confirmados sin cambiar el contrato aritmético de
Task 7 ni las APIs legacy:

- `fecha()` e `instante()` rechazan explícitamente el año `0000`; conservan el
  rango canónico `0001..9999`, aceptan `0001-01-01` y `2024-02-29`, y rechazan
  `2100-02-29` en los cinco campos fiscales de fecha/instante.
- Snapshot v2 usa un validador de CUIT propio: exactamente once dígitos, distinto
  de todo cero y módulo 11 válido. Se aplica a emisor, identidad, receptor CUIT y
  `CbtesAsoc`; `cuitValido` legacy queda intacto.
- La migración forward creada exclusivamente con
  `supabase migration new snapshot_fiscal_v2_fechas_cuit_canonicos` agrega
  `cuit_fiscal_snapshot_valido(text)`, revocado a `PUBLIC`, `anon` y
  `authenticated`, y otorgado sólo a `service_role` para que el validator/RPC
  `SECURITY INVOKER` puedan usarlo. `RESERVAR` valida el payload antes del lock.
- `validar_snapshot_fiscal_v2` declara el dominio anual `0001..9999` antes de
  cualquier cast. La función efectiva y la RPC son copias mecánicas de
  `20260822203901`; el diff contra esa migración muestra únicamente el helper y
  los guards intencionales de fecha/CUIT. Se conservaron firma, `search_path`,
  grants, locks, CAS y hardenings de NC/Task 4.

Entrega manual: aplicar localmente
`20260822215956_snapshot_fiscal_v2_fechas_cuit_canonicos.sql` inmediatamente
después de `20260822203901_snapshot_fiscal_v2_completo.sql`. No se ejecutó ni
se autorizó ninguna migración remota.

### TDD y verificación fresca

- RED TS: `snapshot.test.ts` falló exactamente en los cinco campos con año
  `0000` y en CUIT emisor puntuado (`6 failed / 89 passed`).
- RED SQL: el contrato previo aceptó CUIT todo cero tanto en emisor como en
  receptor (`146 ok / 2 fallas`).
- GREEN focal TS: `95/95`.
- `supabase db reset --debug`: PASS con la nueva migración; un segundo reset
  fresco sin debug también PASS después de ajustar el grant interno.
- `scripts/test-receptor-fiscal-schema.sh`: PASS.
- `scripts/test-fiscal-concurrencia.sh`: PASS, `155 ok / 0 fallas`.
- `scripts/test-venta-fiscal-atomica.sh`: PASS, incluido contrato NC y carreras.
- `scripts/test-facturacion-multiemisor.sh`: PASS.
- `scripts/test-venta-contado.sh`: PASS.
- `scripts/test-nota-credito-sin-factura.sh`: PASS.
- `scripts/test-caja-y-saldos.sh`: PASS, `28 ok / 0 fallas`.
- `npm test`: PASS, 30 archivos; `605 passed / 4 skipped`.
- `npm run typecheck`: PASS.
- `INVOICING_MOCK_MODE=true npm run build:vercel`: PASS; sólo warnings
  preexistentes de `inputValidator`, paths y tamaño de chunks.
- `supabase db lint --level warning`: exit 0; persisten exclusivamente los dos
  hallazgos históricos ajenos ya documentados (`_objetivo` y
  `p_idempotency_key`).
- `git diff --check`: PASS; la migración histórica `20260822161644` no cambió.

No se usó red ARCA, deploy, push, flags de producción ni migraciones remotas.
