# Informe Tarea 11 — errores humanos, detalle auditado y PDF fiscal v3

## Commit funcional

- Base exacta: `58cbb3b2a2f2fb0cc138914f8e482361d119b356`.
- Implementación: `df274cee29ca4ecb3f6801b0eff8e30e4e91b102 feat(fiscal): mostrar auditoría y período de la NC`.
- No se ejecutó ARCA real, deploy, push, producción ni activación de flags. No se reescribió historia.

## Resultado

- La NC fiscal por período traduce validaciones, permisos, FCE no soportada, certificado/configuración, caída previa al request, incertidumbre posterior al request y divergencia de conciliación mediante códigos cerrados y mensajes accionables. Ningún mensaje de Zod, Supabase, SQL, SOAP o ARCA raw llega al usuario ni al resumen persistido.
- El detalle comercial reconstruye un registro de sólo lectura con período, modalidad, motivo, resolución, operador y creación, cliente comercial, receptor fiscal congelado/letra, estado/fase, CAE, autorización/recuperación, marcador de efectos y movimientos exactos persistidos.
- La impresión v3 valida el snapshot persistido y deriva de él receptor, emisor, letra, fecha/número fiscal, período, modalidad, motivo, líneas, neto, IVA, total y CAE. No consulta ni imprime metadata fiscal live ni resolución comercial mutable. El camino v2 conserva su comportamiento.

## Archivos

- Errores y lifecycle: `src/lib/fiscal/error-usuario.ts`, `src/lib/fiscal/emision.ts`, `src/lib/fiscal/emision.server.ts`, `src/lib/fiscal/arca.ts`, `src/lib/fiscal.functions.ts` y sus pruebas focales.
- Impresión: `src/lib/fiscal/impresion.ts`, `src/lib/fiscal/comprobante-pdf.ts` y sus pruebas.
- Detalle/proyección: `src/lib/ventas-proyeccion.ts`, `src/components/ventas/dialogo-detalle-venta.tsx`, nuevo loader paralelo `src/components/ventas/dialogo-detalle-venta-auditoria.ts` y pruebas `dialogo-detalle-venta-auditoria.test.ts` / `ventas-proyeccion.test.ts`.

## TDD: RED → GREEN

- RED inicial: faltaban los códigos/mensajes por fase, paths de período, permiso/FCE/certificado/conflicto, despacho de snapshot v3, metadata PDF v3 y detalle auditado. Las pruebas focales fallaron antes de implementar cada contrato.
- RED de motor: una caída estructurada antes de `REQUEST_INICIADO` devolvía el genérico; un timeout posterior persistía `REQUEST_INCIERTO`; una divergencia v3 persistía `DIVERGENCIA_ARCA`; la credencial ausente propagaba texto técnico; el permiso PostgreSQL `42501` caía en error genérico.
- GREEN de motor: la fase durable determina si el intento es seguro o incierto; después de `REQUEST_INICIADO` siempre se transiciona a `RECONCILIAR`; certificado/configuración no se confunde con caída; divergencia v3 bloquea sin valores remotos; `42501` usa permiso explícito.
- RED de impresión: v3 no era aceptado por la lectura de impresión. GREEN: unión discriminada v2/v3 y validación/hash fail-closed. Durante QA real apareció un RED adicional: el PDF v3 todavía mostraba el número interno live. Se agregó la regresión y se eliminó ese dato sólo para v3; v2 quedó igual.
- RED de detalle: no había campos auditables ni fuentes exactas de intención/movimientos. GREEN: loader fail-closed con cuatro lecturas independientes en `Promise.all`, proyección explícita y UI de sólo lectura para pendiente/aprobada.

## Matriz de mensajes y acciones

| Situación                                         | Código seguro                                           | Mensaje / acción                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fecha desde/hasta inválida                        | `VALIDACION_PERIODO_DESDE` / `VALIDACION_PERIODO_HASTA` | Indica qué fecha completar; se corrige inline antes de emitir.                                                                                       |
| Motivo/modalidad/resolución/items/pagos inválidos | códigos `VALIDACION_*_NC_PERIODO`                       | Copy cerrado por campo; no muestra issues Zod.                                                                                                       |
| Falta de permiso                                  | `PERMISO_NC_PERIODO`                                    | Pide acceso a administrador; el código SQL `42501` no se muestra.                                                                                    |
| FCE no soportada                                  | `FCE_NC_PERIODO_NO_SOPORTADA`                           | Indica asociar comprobantes puntuales; bloquea la emisión por período.                                                                               |
| Certificado ausente, vencido o no autorizado      | `CERTIFICADO_ARCA_INVALIDO`                             | Configuración de administrador; nunca dice “ARCA está caída”.                                                                                        |
| Caída confirmada antes de request durable         | `ARCA_CAIDA_PRE_REQUEST_NC`                             | `ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.` Se libera como corregible porque el request no comenzó. |
| Corte/timeout luego de request durable            | `ARCA_INCIERTA_POST_REQUEST_NC`                         | `ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.` Pasa a `RECONCILIAR`; no ofrece retry ciego.                     |
| Rechazo ARCA confirmado                           | `ARCA_RECHAZO`                                          | Mantiene la traducción de rechazo corregible existente; no se clasifica como caída.                                                                  |
| Divergencia al reconciliar v3                     | `CONFLICTO_RECONCILIACION_NC`                           | Bloquea para revisión y ordena no volver a emitir; persiste sólo nombres de campos únicos/ordenados, no valores remotos.                             |
| Error técnico desconocido                         | código genérico allowlisted según frontera              | Nunca concatena `message`, JSON, SOAP, SQL, payload ni respuesta ARCA raw.                                                                           |

## Seguridad y coherencia del detalle

- `COLUMNAS_VENTA_SEGURAS` incorpora sólo `usuario_id`, `created_at`, `afip_emitido_at`, modalidad, motivo, resolución y `nc_efectos_aplicados_at`. Continúan fuera `afip_error`, claim token, hash/payload de intención y demás secretos.
- La consulta de pagos de una NC por período selecciona campos explícitos y excluye `detalle`; reintegros previstos, stock y cuenta corriente también usan columnas explícitas. El loader reemplaza cualquier error de fuente por `No se pudo reconstruir la auditoría de la nota de crédito.`
- Pendiente: muestra intención persistida antes del CAE y aclara que aún no hay movimientos comerciales. Aprobada: exige CAE y marcador de efectos para mostrar pagos, stock y cuenta corriente aplicados, con importes/cantidades y timestamps persistidos.
- No se agregaron botones de editar/eliminar. Los estados de carga/error usan `role=status` / `role=alert`; la revisión React dejó fetches independientes en paralelo, sin effects ni estado derivado agregado. ESLint quedó sin warnings.

## QA textual y visual del PDF v3

- Se generó `tmp/pdfs/nc-periodo-v3-qa.pdf` con `npx vite-node tmp/pdfs/generar-qa-v3.ts`, invocando `prepararDatosFiscalesImpresos`, `qrAfipDataUrlObligatorio` y `generarComprobantePdf` reales sobre un snapshot v3 válido. No se llamó ARCA.
- `pdfinfo tmp/pdfs/nc-periodo-v3-qa.pdf` confirmó PDF 1.3, A4, una página y sin cifrado/JavaScript.
- El Python global no traía `pypdf`/`pdfplumber`; se creó `tmp/pdfs/.qa-venv`, se instalaron sólo allí y se extrajeron todas las páginas con ambos lectores. Ambos devolvieron período `01/08/2026 a 15/08/2026`, modalidad, motivo, receptor congelado, tres líneas, neto/exento/no gravado/IVA/total y CAE. Tras la corrección, ninguno devolvió cliente, línea, fecha ni número interno live.
- `pdftoppm -png -r 150 tmp/pdfs/nc-periodo-v3-qa.pdf tmp/pdfs/nc-periodo-v3-qa` renderizó la página completa. La inspección del PNG a resolución original confirmó encabezado, letra, receptor, caja de asociación, tabla, totales, QR, CAE y leyendas legibles, sin clipping, overlap, cuadros negros ni glifos rotos.
- Se repitieron generación, extracción y render después de suprimir el número interno live. El PDF, PNG, textos, script y virtualenv temporales se enviaron a la papelera; `tmp/pdfs/` quedó vacío y no se versionó ningún PDF de QA.
- La skill PDF ya había sido registrada por el controller; no se volvió a ejecutar su marker.

## Verificaciones

- Basal antes de T11: focales existentes 101/101; suite completa 76 archivos pasados, 2 omitidos; 1610 pruebas pasadas, 22 omitidas.
- Focal ampliada: 9 archivos, 316 pruebas pasadas (errores, fachada, ARCA/runtime, motor/server, impresión/PDF, proyección y detalle).
- Focal final detalle/PDF: 2 archivos, 47 pruebas pasadas.
- Completa final: `npm test` → 77 archivos pasados, 2 omitidos; 1638 pruebas pasadas, 22 omitidas.
- `npm run typecheck` pasó.
- ESLint focal de los 19 archivos funcionales pasó sin errores ni warnings.
- Prettier focal y `git diff --check` pasaron.

## Límites

- No se expone la resolución comercial dentro del snapshot/PDF fiscal v3: por contrato, esa liquidación no integra la evidencia fiscal congelada. Sí se reconstruye en el detalle desde `ventas.nc_resolucion` y movimientos persistidos inmutables.
- No se ejecutaron ARCA real, certificados reales, browser autenticado, migraciones, deploy, push, producción ni flags.

## Fix round 1 — cierre de auditoría y clasificación de incertidumbre

### Commit funcional

- `578880ef3fc2a2b9fa7c48b01399cc7e3f6b7c07 fix(fiscal): cerrar auditoría de NC período`.

### Correcciones

- `ArcaRespuestaIncierta` ya no se considera una caída confirmada. Sólo `AfipTimeout`, códigos estructurados de transporte o un código público de caída conservan los copies exactos de indisponibilidad. Una respuesta presente pero malformada, contradictoria o con otra identidad sigue durablemente en `RECONCILIAR`, no libera la reserva ni ofrece retry, y usa `La respuesta fiscal es incierta y requiere conciliación.` sin afirmar que ARCA cayó.
- El audit de efectos ya no fabrica `pagosAplicados: []` cuando `venta_pagos` falla. `detalleQuery.error` bloquea todo el bloque auditado con un mensaje fijo y seguro; nunca aparece “Sin reintegros de caja” ante una lectura incompleta.
- El loader valida con `validarSnapshotFiscalV3`, compara `snapshot.hash` con `ventas.afip_snapshot_hash` y exige que `snapshot.venta.id` coincida con la venta. Período, modalidad, motivo, receptor y letra salen únicamente de ese snapshot validado. Snapshot alterado o hash externo divergente fallan cerrados; se eliminó la alternativa “Pendiente de congelar”.
- Operador, cliente y producto se identifican por `ventas.usuario_id`, `ventas.cliente_id` y `stock_movimientos.producto_id`. Nombre/username del perfil, razón/documento del cliente y código/nombre del producto se rotulan explícitamente como datos actuales; no se presentan como identidad histórica congelada.

### Evidencia segura de autorización

- Se agregó `evidenciaAutorizacionNotaCreditoPeriodo`, endpoint GET user-bound que primero autoriza `PREVISUALIZAR`. La tabla `emision_fiscal_intentos` no es legible por el navegador; el servidor usa admin únicamente después de autorizar la venta.
- La consulta no selecciona `respuesta_resumen` completo. Usa aliases escalares cerrados para `resultado`, `tipo`, `fuente`, `emitido_at` y `coincidencia_completa` dentro de `respuesta_resumen.evidencia_externa`, más `updated_at`. No selecciona ni devuelve payload, claim, errores, hash del intento, CAE, observaciones o valores arbitrarios.
- Emisión directa exige literalmente `APROBADO / EMISION / A / FECAESolicitar` y usa el `emitido_at` canónico ya validado por la transición SQL.
- Recuperación exige literalmente `RECUPERADO_CAE / CONSULTA_ARCA / COINCIDE / FECompConsultar / true`. Como el contrato persistido de recuperación usa el reloj del servidor y no incluye un timestamp dentro de `consulta_recuperacion`, `confirmadoAt` se toma de `emision_fiscal_intentos.updated_at`: el trigger `trg_emision_fiscal_intentos_upd` lo actualiza cuando el wrapper persiste esa evidencia externa. Esta decisión evita inventar un origen a partir de `ventas.afip_emitido_at` y distingue los dos caminos desde la evidencia del intento.
- El cliente recibe exclusivamente `{ origen: "EMISION" | "RECUPERACION", confirmadoAt }`. Una fila ausente en pendiente devuelve `null`; evidencia malformada o una lectura fallida bloquea el audit aprobado con mensajes fijos sin filtrar datos del intento.

### TDD RED → GREEN

- RED motor: 2 fallas demostraron que `ArcaRespuestaIncierta` devolvía `true` en `esCaidaArcaConfirmada` y activaba el copy de caída post-request. GREEN: timeout/transporte conserva el copy exacto; incertidumbre no-transporte conserva `RECONCILIAR` con copy genérico y sin raw.
- RED audit: 5 fallas demostraron la afirmación falsa ante pagos fallidos, ausencia de snapshot/evidencia en el resultado, falta de validación del hash, uso de metadata live y copy indistinto de autorización/recuperación. GREEN: gating fail-closed, snapshot canónico, identidades por ID y ambos orígenes visibles.
- RED evidencia: el nuevo contrato no existía. GREEN: tres pruebas cubren emisión directa, recuperación y fail-closed ante esquema/error técnico. La prueba de seguridad verifica la proyección cerrada y que el resultado no contiene respuesta, payload, error ni hash.
- Regresión adicional: snapshot v3 con cuerpo alterado y hash previo es rechazado por el validador canónico, además del caso de hash externo divergente.

### Verificaciones Fix round 1

- Focal ampliada: `error-usuario`, motor, evidencia, fachada, detalle auditado, detalle comercial, impresión, PDF y proyección → 9 archivos, 220 pruebas pasadas.
- Focal GREEN posterior de errores/evidencia/detalle/fachada → 5 archivos, 125 pruebas pasadas.
- Completa final: `npm test` → 78 archivos pasados, 2 omitidos; 1649 pruebas pasadas, 22 omitidas.
- `npm run typecheck` pasó.
- ESLint focal pasó sin errores ni warnings; Prettier focal y `git diff --check` pasaron.
- `impresion.test.ts` y `comprobante-pdf.test.ts` pasaron dentro de la focal. No se modificó el código PDF ni se regeneró un artefacto visual: se preservó el PDF v3 aprobado y el camino v2 sin regresión.
- Revisión React: las cinco lecturas independientes del audit corren en un único `Promise.all` bajo React Query; no se agregaron effects ni estado derivado. Los errores de auditoría mantienen `role=alert`.
- No se ejecutaron ARCA real, deploy, push, producción, flags ni reescritura de historia.
