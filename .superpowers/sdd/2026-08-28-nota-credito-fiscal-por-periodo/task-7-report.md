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
