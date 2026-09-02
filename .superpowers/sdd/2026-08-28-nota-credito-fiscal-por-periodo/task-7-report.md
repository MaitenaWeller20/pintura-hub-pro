# Tarea 7 — receptor y emisor fiscal determinista por período

Fecha: 2026-08-29

Base exacta: `a1a9d1498a2b68b1b359953b8fd6161e35c0bb9c`

Commits de implementación:

- `0fe1c78` — `feat(fiscal): preparar emisión de notas por período`
- `3bb30ac` — `refactor(fiscal): exigir asociación explícita del receptor`

## Resultado

Se integró el discriminante fiscal `NINGUNA | COMPROBANTE | PERIODO` en autorización, resolución del receptor, preflight, reserva y construcción del snapshot. Las notas vinculadas conservan el camino v2 y su snapshot original aprobado; las notas por período usan selección de letra automática A/B/C y construyen un snapshot v3 desde la lectura exacta congelada. No se agregaron efectos de caja, stock, pagos o cuenta corriente al aprobar.

La lectura PostgreSQL exacta ahora incluye el cliente comercial congelado, todos los campos de período, hashes/idempotencia/intentos, ítems ordenados e intención de reintegro separada. La cola expone sólo los metadatos de período autorizados. La lectura de evidencia y el guardado de receptor despachan snapshots v2/v3 mediante `validar_snapshot_fiscal_persistido`, manteniendo v2-only para el comprobante original vinculado.

## Archivos

- `supabase/migrations/20260829161737_lectura_nc_periodo_fiscal.sql`: recrea `leer_venta_fiscal_exacta`, `cola_fiscal_lectura` y `guardar_receptor_fiscal_desde_venta` con contratos v2/v3, permisos y controles existentes.
- `src/lib/fiscal/emision.ts`: asociación y selección de letra discriminadas; preflight, snapshots, payload y reconciliación aceptan la unión persistida; rechazo temprano de asociación/letra/CbteTipo inválidos.
- `src/lib/fiscal/emision.server.ts`: Zod exacto ampliado, preparación desde valores persistidos, receptor confirmado, derivación A/B/C y creación de snapshot v3 desde la reserva canónica.
- `src/lib/fiscal/receptor.server.ts`: asociación obligatoria, NC vinculada sólo con original y NC por período con cliente/favorito/manual; padrón vigente sigue siendo autoridad para CUIT.
- `src/lib/fiscal/cola.functions.ts`, `src/lib/ventas-proyeccion.ts`, `src/integrations/supabase/types.ts`: proyecciones y tipos seguros para período.
- `src/routes/_authenticated/ventas.index.tsx`, `src/lib/fiscal/emision-legacy.server.ts`: `esNotaInterna` recibe las fechas persistidas de período en todos los call sites alcanzados.
- Pruebas actualizadas/agregadas en receptor, emisor, integración, cola y fixtures consumidores de `ColaFiscalFila`.

## TDD: RED

Se escribió primero cobertura para:

- receptor manual de una NC por período confirmado por padrón y texto manual no autoritativo;
- rechazo de `COMPROBANTE_ORIGINAL` en período;
- NC sin asociación y selección explícita de letra rechazadas antes del claim;
- CbteTipo no estándar detenido antes de `REQUEST_INICIADO`;
- lectura exacta estricta y construcción/validación del snapshot v3;
- cola con metadatos de período sin fuga de `reintegrosIntencion`.

El primer focal quedó RED con 5 fallas esperadas: el receptor todavía exigía original, el constructor sólo admitía v2 y el esquema exacto rechazaba las claves nuevas. El caso FCE/no estándar también quedó RED porque alcanzaba `REQUEST_INICIADO`. No se modificó código productivo antes de observar esas fallas.

## TDD: GREEN y verificaciones finales

- Basal focal previo: 133 pruebas pasaron y 7 quedaron omitidas.
- `npx supabase db reset`: OK con todas las migraciones, incluida `20260829161737_lectura_nc_periodo_fiscal.sql`.
- `bash scripts/test-snapshot-fiscal-v3.sh`: OK, contrato v3 completo.
- `bash scripts/test-nota-credito-periodo-schema.sh`: OK.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: OK.
- Focal receptor/emisor/integración/cola: 5 archivos pasaron, 1 opt-in omitido; 174 pruebas pasaron y 16 quedaron omitidas.
- Integración real contra Supabase local, con ARCA bloqueada/mocked: 1 archivo y 8 pruebas pasaron.
- `npm test`: 73 archivos pasaron, 1 omitido; 1520 pruebas pasaron y 20 quedaron omitidas.
- `npm run typecheck`: OK.
- Prettier focal de todos los TS/TSX modificados: OK.
- ESLint de los archivos fiscales modificados, excluido el basal indicado abajo: OK.
- `git diff --check` y control de whitespace de la migración nueva: OK.

## Decisiones

- `AsociacionPreparadaFiscal` es obligatoria también en `VentaParaReceptor`; no queda fallback que vuelva a inferir asociación por un `afip_cbte_asoc_id` nulo.
- El flujo público vigente A/B conserva compatibilidad al normalizar la letra string a `{ origen: "EXPLICITA" }`; el nuevo caller de período debe usar `{ origen: "AUTOMATICA_NC_PERIODO" }`.
- La resolución comercial (`REINTEGRO | SALDO_FAVOR`) permanece en la fila exacta, asociación preparada y cola. No se agrega al snapshot v3 porque su contrato deliberadamente no persiste efectos comerciales.
- Después de congelar no se vuelve a leer el cliente comercial vivo: receptor, ítems, totales, período, identidad y hashes salen de la lectura/reserva autoritativa.
- Se mantuvieron los locks, transiciones e idempotencia existentes; no se habilitó retry ciego después de iniciar una solicitud.

## Basales y riesgos restantes

- El ESLint focal que incluye `src/routes/_authenticated/ventas.index.tsx` reporta 13 usos preexistentes de `any`; el resto de archivos modificados pasa ESLint. Esta tarea sólo cambió los argumentos period-aware de `esNotaInterna` y conservó esos tipos existentes.
- La integración opt-in histórica de `cola.test.ts` no puede completar su setup porque intenta escribir con el writer fiscal legacy ya retirado (`El escritor fiscal legacy está retirado...`). La prueba unitaria segura de cola y la integración del emisor sí pasan; el fallo antecede y no pertenece al alcance de esta tarea.
- Aplicar efectos comerciales post-CAE corresponde a Tarea 8. Server action/UI, errores finales y PDF quedan fuera de esta entrega según el brief.
- No se usó ARCA real, certificados, deploy, push ni producción.

## Fix round 1

Fecha: 2026-08-29

Commit de implementación: `7c3330f` — `fix(fiscal): cerrar ACL de cola y proyección C`

### Scope ruling

Por decisión explícita del controller no se recreó `transicionar_emision_fiscal` ni se implementó el lifecycle SQL `RESERVAR/APROBAR/RECUPERAR_CAE`. Esa RPC, su despacho de `snapshot_version` v2/v3 y los efectos atómicos post-CAE pertenecen a Tarea 8. Esta corrección conserva las interfaces del motor para esa integración y prueba hasta la frontera pre-transición/request con dobles; no simula un lifecycle SQL inexistente.

### Correcciones

- `cola_fiscal_lectura` ahora es una frontera `SECURITY DEFINER` mínima, con owner `postgres`, `search_path=''` y `EXECUTE` sólo para `authenticated`. La función conserva sus verificaciones internas de `auth.uid()`, perfil activo, `puede_facturar`, asignación y sucursal; `validar_snapshot_fiscal_persistido` sigue sin ser ejecutable por roles API.
- Se agregó integración PostgreSQL real como rol `authenticated`: un usuario autorizado lee filas v2/v3, mientras usuarios sin capacidad o sin sucursal reciben `42501`. La respuesta no expone la intención de reintegro.
- `proyectarSnapshotParaArca` es la única proyección compartida por payload y reconciliación. Para tipos C declara `ImpNeto=ImpTotal`, IVA/importes no discriminados en cero y colecciones `Iva`/tributos vacías; A/B preservan exactamente el desglose del snapshot.
- Se agregaron happy paths A/B/C del motor hasta `REQUEST_INICIADO`, con reserva exacta del snapshot v3 y request mockeado. Se mantienen los rechazos de asociación, FCE, comprobantes internos y ausencia de fallback.
- Los fixtures v3 de adaptador/reconciliación ahora salen de `crearSnapshotFiscalV3`, sin doble cast. Se actualizó el comentario obsoleto “Writer v2”. El contrato receptor también reemplazó snapshots sintéticos inválidos por el fixture v2 canónico para ejecutarse con los guards actuales activos.

Archivos principales del fix:

- `supabase/migrations/20260829171535_corregir_acl_cola_fiscal_v2_v3.sql`
- `src/lib/fiscal/cola-acl.integration.test.ts`
- `src/lib/fiscal/proyeccion-arca.ts`
- `src/lib/fiscal/snapshot-v3.test-fixture.ts`
- `src/lib/fiscal/arca.ts`, `src/lib/fiscal/reconciliacion.ts`
- `src/lib/fiscal/arca.test.ts`, `src/lib/fiscal/reconciliacion.test.ts`, `src/lib/fiscal/emision.test.ts`
- `scripts/test-receptor-fiscal-schema.sh`

### TDD RED/GREEN

- RED C: los nuevos casos de payload y consulta C fallaron con neto `1000`, IVA `210`, no gravado/exento comerciales y `alicuotasIva.length`; era la divergencia denunciada.
- GREEN C: el mismo focal quedó en 100 pruebas pasadas usando la proyección común; A/B conservaron sus importes y alícuota.
- RED ACL real: el usuario autorizado recibió `42501 permission denied for table ventas` al invocar la cola invoker. El catálogo confirmó `prosecdef=false`; los usuarios sin capacidad/sucursal ya quedaban bloqueados.
- GREEN ACL real: 2/2 pruebas pasaron después de la migración; autorizado obtiene v2/v3 y ambos negativos siguen en `42501`. El contrato de catálogo verifica definer/owner/search path/grants y que el dispatcher permanece owner-only.

### Verificación final

- `npx supabase db reset`: OK; aplicó todas las migraciones hasta `20260829171535_corregir_acl_cola_fiscal_v2_v3.sql`.
- `npx supabase db diff --local --schema public`: OK, `No schema changes found`.
- `bash scripts/test-receptor-fiscal-schema.sh`: OK completo, incluida ACL/catalog y fixtures canónicos.
- `bash scripts/test-snapshot-fiscal-v3.sh`: OK.
- `bash scripts/test-nota-credito-periodo-schema.sh`: OK.
- `bash scripts/test-nota-credito-periodo-fiscal.sh`: OK.
- Focal emisor/receptor/adaptador/reconciliación/cola: 6 archivos, 252 pruebas pasadas y 8 omitidas.
- Integración ACL autenticada local v2/v3: 1 archivo, 2 pruebas pasadas.
- `npm test`: 73 archivos pasados, 2 omitidos; 1525 pruebas pasadas y 22 omitidas.
- `npm run typecheck`: OK.
- Prettier y ESLint sobre todos los TS modificados: OK.
- `git diff --check`: OK.

### Basales y riesgos

- `npm run lint` global continúa rojo por 4262 errores y 9 warnings preexistentes fuera de este diff; el lint focal de todos los archivos TypeScript tocados queda verde.
- `supabase db lint --local --level warning` conserva el error basal de `public.cambiar_precios_masivo` por la relación temporal `_objetivo`; no involucra este cambio. `supabase db advisors --local` conserva advisors históricos de RLS/vistas/funciones; la nueva frontera sí fija owner/search path/grants y tiene cobertura catalogada.
- La integración histórica `emision.integration.test.ts` requiere `transicionar_emision_fiscal`; se deja para Tarea 8 por el scope ruling. El request no alcanza red externa: ARCA está mockeada/bloqueada en las pruebas.
- No se aplicaron efectos de caja, stock, pagos o cuenta corriente. No se usaron ARCA real, certificados, deploy, push ni producción.

## Fix round 2

Fecha: 2026-08-29

Commit de implementación: `67255b4` — `fix(fiscal): cerrar condición automática sin padrón`

### Resultado y scope

- La selección automática de NC por período ya no deriva A/C desde RI o MONOTRIBUTO meramente declarados. Si padrón devuelve `condicionIvaConfirmada=null`, o no hay adaptador de padrón, el único fallback compatible es `CONSUMIDOR_FINAL | EXENTO`.
- Una condición confirmada por padrón siempre prevalece sobre el texto manual/favorito: RI y MONOTRIBUTO no pueden ser sobrescritos por la declaración del operador.
- La validación server-real de una NC por período ocurre antes de adquirir el claim. Para los casos válidos, la preparación se repite después del claim y esa segunda lectura sigue siendo la canónica usada para construir/reservar el snapshot v3; no se debilitó el lock ni se congelaron datos del precheck.
- No se implementó ni recreó el lifecycle SQL de `transicionar_emision_fiscal`: continúa asignado a Tarea 8. La nueva integración reemplaza únicamente esa transición y ARCA con dobles, sin efectos post-CAE ni red externa.

### Cobertura server-real

La batería de `emision.server.test.ts` usa `crearDependenciasEmisionFiscalServer`, `resolverReceptorFiscal`, `determinarLetraNcPeriodo`, `construirSnapshotFiscalDesdeLectura`/factory v3 y `crearPayloadCaeDesdeSnapshot` reales. Cubre:

- RI confirmada aunque el texto declare MONOTRIBUTO → A, CbteTipo 3, condición ARCA 1.
- CF sin inscripción confirmable → B, CbteTipo 8, condición ARCA 5.
- EXENTO sin inscripción confirmable → B, CbteTipo 8, condición ARCA 4.
- MONOTRIBUTO confirmado aunque el texto declare RI, con emisor monotributista → C, CbteTipo 13, condición ARCA 6 y payload sin colección `Iva`.
- RI/MONOTRIBUTO declarados sin confirmación → rechazo con cero transiciones y cero llamadas ARCA.

### TDD RED/GREEN

- RED receptor/padrón nulo: 2 casos automáticos resolvían indebidamente a RI/MONOTRIBUTO en vez de rechazar.
- GREEN: ambos rechazan con `CONDICION_FISCAL_INCOMPATIBLE`; la matriz RI/MONOTRIBUTO confirmados y CF/EXENTO de fallback permanece válida.
- RED sin adaptador: 2 casos automáticos conservaban el receptor manual RI/MONOTRIBUTO sin evidencia.
- GREEN: el guard común limita ese fallback a CF/EXENTO para MANUAL/FAVORITO, sin alterar el flujo v2 de letra explícita.
- RED motor: el caso server-real inválido adquiría claim y resolvía `ERROR_CORREGIBLE`; la prueba observó que no rechazaba antes de transición.
- GREEN motor: el mismo caso rechaza antes de claim/request con 0 transiciones y 0 requests; la preparación canónica bajo claim se mantiene para los válidos.

### Verificación

- Focal receptor/emisor/server/adaptador/reconciliación/período: 6 archivos pasados, 247 pruebas pasadas; la integración ACL opt-in quedó omitida en ese comando.
- Batería server-real nueva: 6 pruebas pasadas (A/B/C más rechazos preclaim).
- Integración ACL autenticada local v2/v3: 2/2 pasadas, sin regresión del fix round 1.
- `npm test`: 73 archivos pasados, 2 omitidos; 1539 pruebas pasadas y 22 omitidas.
- `npm run typecheck`: OK.
- Prettier y ESLint sobre todos los archivos modificados: OK.
- `git diff --check`: OK.
- Se revisó el changelog oficial de Supabase; los avisos vigentes de Node/TypeScript no cambian el contrato RPC usado aquí. No hubo cambios SQL ni migraciones en este round.

### Riesgos/basales

- La integración histórica que exige la RPC real `transicionar_emision_fiscal` sigue fuera por el scope ruling de Tarea 8. La cobertura nueva valida el pipeline server-real hasta snapshot/adaptador y usa un lifecycle doble explícito.
- Se conservan los basales globales de lint/db lint/advisors ya documentados en Fix round 1; ningún archivo nuevo queda con errores focales.
- No se usaron ARCA real, certificados, deploy, push ni producción.
