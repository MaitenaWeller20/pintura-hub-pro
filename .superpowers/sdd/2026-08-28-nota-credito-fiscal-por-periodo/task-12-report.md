# Informe Tarea 12 — verificación E2E y gate de rollout de NC por período

## Base y alcance

- Base exacta: `1b3bc2ceedf41e6506b26b4968b3243165e980bd`.
- Se verificó la historia completa sobre Supabase local y ARCA mock: Nueva venta → modo/permiso/receptor → server function/RPC → lifecycle fiscal → efectos comerciales → cola/detalle/PDF.
- La capacidad queda deployable pero apagada: ninguna prueba ni migración activa `nota_credito_periodo_enabled` por defecto.
- No se llamó ARCA real, no se usaron certificados reales, no se desplegó, no se hizo push, no se tocó producción y no se reescribió historia Git.

## Corrección de revisión — ronda 1

Esta sección corrige y reemplaza las afirmaciones de la primera entrega donde se indicaba que el detalle no exponía evidencia reservada y que el lint nuevo estaba limpio sólo por inspección focal.

- `detalleVentaFiscalSegura` ya no devuelve `COLUMNAS_VENTA_SEGURAS`. Autoriza primero con el cliente user-bound y, recién después, abre lecturas privilegiadas para validar snapshot/hash, paridad de columnas y fuentes de auditoría. Su única salida es `DetalleVentaFiscalPresentacion`; cabecera, auditoría y cada elemento de sus arrays se construyen campo por campo y sin `snapshot`, `hash`, `payload`, `raw`, `afip_error` ni payloads de intentos.
- El navegador recibe receptor, asociación y auditoría ya validados/derivados en servidor. El diálogo dejó de leer o interpretar `afip_snapshot`/`afip_snapshot_hash` y la fila del listado sólo abre el detalle mediante esa server function autorizada.
- Una regresión contractual recorre recursivamente el DTO completo y rechaza toda clave reservada. Otra prueba demuestra que, si falla la autorización user-bound, no se ejecuta ninguna lectura admin.
- La historia de fechas ahora ingresa realmente `desde > hasta`, comprueba el copy exacto y cero POST. La historia flag-off persiste una `VENTA` ordinaria y comprueba en base venta, ítem, pago y stock únicos, sin deuda ni intento fiscal. El PDF se interpreta desde sus operadores de texto y verifica razón social completa congelada, CAE exacto, motivo exacto, modalidad y las dos fechas completas.
- Los tipos generados de Supabase se excluyen formalmente de ESLint. El gate `npm run lint:no-new-debt` compara hallazgos agrupados por archivo/regla/severidad/mensaje contra un baseline versionado: queda GREEN en 986/986. `npm run lint` global continúa ROJO por exactamente 986 hallazgos históricos (977 errores y 9 warnings); no se lo declara verde.
- Medición reproducible: en la base exacta `1b3bc2c`, aplicando sólo la exclusión formal del archivo generado, había 988 hallazgos (979 errores y 9 warnings). El archivo generado aislado pasó de 3285 errores en la base a 3524 en la salida local actual: el aumento mecánico es exactamente 239. Al quedar fuera del análisis fuente, la deuda no generada baja de 988 a 986 y el gate impide cualquier incremento o mensaje nuevo.

## Resultado funcional

- Administrador y empleado autorizado pueden crear las dos modalidades fiscales por período. La devolución materializa stock y reintegros exactos sólo después del CAE; el ajuste acredita cuenta corriente sin movimiento de stock.
- Un empleado sin capacidad no ve la opción y la RPC directa falla con `42501` sin mutaciones. Fecha, motivo y reintegro inválidos quedan inline y no disparan un POST.
- El receptor comercial se valida por padrón mock determinista; “otro receptor” conserva separado al cliente comercial sobre el cual se aplican los efectos.
- El happy path obtiene CAE mock, persiste snapshot v3/`PeriodoAsoc`, aplica efectos una sola vez, aparece en la cola y reconstruye detalle auditado/PDF.
- La caída anterior a `REQUEST_INICIADO` muestra exactamente `ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro momento.` y no aplica efectos.
- El timeout posterior muestra exactamente `ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.`, retira la reemisión ciega, pasa por `RECONCILIAR` y recupera el mismo CAE con una única aplicación de efectos.
- La NC total vinculada conserva snapshot v2 `COMPROBANTE_ORIGINAL` y un único `CbtesAsoc`; la NC por período conserva asociación puntual nula.
- Con el flag nuevo apagado desaparece sólo el modo por período. La venta ordinaria v2, la conversión de presupuestos y la NC vinculada permanecen operativas.

## Historias E2E deterministas

| Historia          | Fronteras comprobadas                                                                             | Resultado |
| ----------------- | ------------------------------------------------------------------------------------------------- | --------- |
| Sin permiso       | UI oculta, perfil/rol, RPC directa y ausencia de efectos                                          | GREEN     |
| Validación inline | `desde > hasta` real, copy exacto, motivo corto y reintegro incompleto; cero POST                 | GREEN     |
| Devolución admin  | CUIT comercial/padrón, snapshot v3, CAE, reintegros, stock, cola, detalle y PDF parseado completo | GREEN     |
| Ajuste empleado   | otra sucursal autorizada, otro receptor fiscal, cliente comercial, saldo a favor y stock vacío    | GREEN     |
| Flag off          | opción ausente y `VENTA` ordinaria persistida; efectos comerciales verificados en base            | GREEN     |
| Caída previa      | copy exacto, error durable corregible y vector comercial intacto                                  | GREEN     |
| Timeout posterior | copy exacto, sin botón de emisión, conciliación, CAE recuperado, un intento y efectos únicos      | GREEN     |
| NC vinculada      | receptor/letra heredados, CAE y `CbtesAsoc` v2 exacto                                             | GREEN     |
| Detalle/PDF       | cabecera user-bound, items/pagos, auditoría v3, descarga y foco restaurado                        | GREEN     |

Los escenarios incompatibles con el proceso mock actual se omiten explícitamente por nombre. `OK` ejecuta las cinco historias generales y omite sólo las dos de caída; cada proceso de caída ejecuta únicamente su historia correspondiente.

## Full-story verification y RED → GREEN

1. **Permiso y fixture local.** RED: la acción directa no podía demostrar el rechazo real y los efectos requerían una caja abierta. GREEN: fixture con usuarios locales, permisos/capacidad, sesión de caja y lecturas exactas; el usuario no autorizado recibe `42501` y no se usa capability de servicio en la acción probada.
2. **Padrón y browser.** RED: el mock no resolvía los CUIT de ambas historias y un import estático de código Node llegaba al cliente. GREEN: padrón local determinista para receptor comercial/alternativo e import dinámico dentro del boundary servidor; las historias controlan consola.
3. **Validación inline.** RED: el diálogo mostraba el error pero no lo exponía con semántica de alerta. GREEN: `role=alert`, copies humanos y cero POST antes de corregir.
4. **Recuperación incierta.** RED: el mock posterior al request no sobrevivía entre server functions y el diálogo se cerraba antes de mostrar la instrucción de no reemitir. GREEN: recuperación a partir del snapshot fiscal persistido, diálogo retenido en conciliación, acción ciega retirada y CAE/efectos recuperados una vez.
5. **Detalle autoritativo.** RED inicial: el navegador ya no tenía `SELECT` suficiente sobre la cabecera y las fuentes auditadas seguían dependiendo de lecturas directas. GREEN inicial: `detalleVentaFiscalSegura` autorizó antes de las lecturas admin. RED de revisión: esa función todavía serializaba el snapshot y su hash para que el navegador los interpretara. GREEN final: DTO de presentación cerrado, derivación/validación enteramente servidor, contrato recursivo de claves reservadas y orden user-bound → admin probado.
6. **ACL de Ventas.** RED real: `/ventas` devolvió HTTP 403/PostgREST `42501` porque la allowlist de columnas era anterior a las columnas de período; `scripts/test-error-fiscal-no-expuesto.sh` informó que `nc_periodo_modalidad` había perdido permiso. GREEN: migración imperativa creada por CLI que otorga sólo seis columnas operativas a `authenticated`; el script verifica usuario autorizado/no autorizado, `afip_error` y `nc_periodo_payload_hash` continúan denegados y RLS sigue activa.
7. **NC vinculada.** RED: el guard SQL real rechazó reservar una NC fixture cuyo original no estaba anulado. GREEN: el setup owner-only expresa el estado de producción `ANULADA`/`venta_anulada_por`; el flujo browser real emite v2 y prueba el `CbtesAsoc` exacto.
8. **Frontera de detalle E2E.** RED: el test de recuperación interceptaba `/rest/v1/ventas`, pero la cabecera ya cruza `detalleVentaFiscalSegura` por `/_serverFn`, de modo que nunca inyectaba la falla. GREEN: el test identifica la exportación serverFn, demora/falla esa frontera real, valida copy humano, reintento y foco; el fallo de items también dejó de esperar un código técnico visible.
9. **Suite montada.** RED: `npm test` dejó 4 fallos porque el mock de `facturacion.cola-lifecycle.test.ts` no exportaba la nueva fachada. GREEN: doble explícito `detalleVentaFiscalSegura`; el archivo pasa 4/4 y, luego de sumar el contrato del DTO, la suite completa pasa 1704 pruebas.
10. **Cobertura browser de revisión.** RED: la primera variante de `desde > hasta` seguía chocando antes contra la validación de motivo y luego contra la de producto; el test no había aislado la frontera. GREEN: motivo y producto válidos antes de invertir el rango, copy exacto y cero POST. En flag-off, un selector parcial de cliente era ambiguo; el selector exacto permitió persistir y comprobar la venta ordinaria real.
11. **Lint reproducible.** RED: sin baseline el gate falla explícitamente y la salida generada sumaba 239 errores mecánicos. GREEN: exclusión documentada del artefacto generado, baseline estable por identidad de hallazgo y gate 986/986; el lint global sigue expuesto como deuda histórica, no como éxito.
12. **Cierre recursivo del DTO.** RED de inspección final: aunque la cabecera era cerrada, el bloque de auditoría se retornaba por referencia; el ataque de contrato observó cuatro claves inyectadas (`snapshot_hash`, `raw`, `intent_payload`, `payload`). GREEN: proyección explícita de la unión fiscal, operador, evidencia y filas de reintegro/stock/cuenta corriente; el mismo ataque recursivo queda 2/2.

## Supabase reproducible y seguridad

- CLI usada: Supabase `2.107.0`.
- `supabase db reset --local` se ejecutó con éxito y aplicó toda la secuencia, incluida `20260830030502_restaurar_lectura_segura_nc_periodo.sql`. No se usó `--linked`, `db push`, MCP remoto ni proyecto alojado.
- La migración se creó con `supabase migration new restaurar_lectura_segura_nc_periodo`; no se inventó un timestamp ni se editó una migración aplicada. Otorga `SELECT` a `authenticated` sólo sobre `motivo_nota_credito`, `nc_efectos_aplicados_at`, `nc_periodo_modalidad`, `nc_resolucion`, `periodo_asoc_desde` y `periodo_asoc_hasta`.
- `supabase gen types typescript --local` regeneró enums, columnas, tablas y firmas desde la base reseteada. El archivo versionado coincide byte a byte con la salida salvo la línea vacía adicional que la CLI imprime al final, normalizada para que `git diff --check` no reporte `blank line at EOF`.
- La ausencia de `convertir_presupuesto_en_venta` en los tipos no es drift: `20260824025115_retirar_escritor_fiscal_legacy.sql` verifica y elimina explícitamente esa firma y agrega un `CHECK` que impide reactivar el writer legacy en un esquema ya migrado. Se preservó un boundary estructural tipado para instalaciones anteriores al corte; flags legacy/v2 están cubiertos por 19 pruebas y la conversión v2 por 4 historias browser.
- `scripts/test-error-fiscal-no-expuesto.sh` comprueba ACL real con roles, RLS y rollback. `scripts/test-auditoria-recuperacion-cae.sh` prueba que la evidencia SQL de recuperación se persiste antes de materializar efectos.
- `supabase db advisors --local --type security --level warn --fail-on error` no encontró errores. Conserva warnings históricos: cuatro funciones de normalización con `search_path` mutable, `pg_trgm` en `public` y policies amplias preexistentes de `clientes`/`proveedores`; no se ampliaron en esta tarea.
- El bundle estático Vercel y `src/integrations/supabase/client.ts`, rutas y componentes no contienen `SUPABASE_SERVICE_ROLE_KEY`/`SERVICE_ROLE_KEY`. Los clientes admin sólo aparecen tras imports servidor y autorización previa.

## Matriz de verificación final

| Gate                                                                                    | Resultado                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bash scripts/test-nota-credito-periodo-schema.sh`                                      | GREEN                                                                                                                                                                    |
| `bash scripts/test-snapshot-fiscal-v3.sh`                                               | GREEN                                                                                                                                                                    |
| `bash scripts/test-nota-credito-periodo-fiscal.sh`                                      | GREEN                                                                                                                                                                    |
| `bash scripts/test-receptor-fiscal-schema.sh`                                           | GREEN                                                                                                                                                                    |
| `bash scripts/test-venta-fiscal-atomica.sh`                                             | GREEN                                                                                                                                                                    |
| `bash scripts/test-fiscal-concurrencia.sh`                                              | GREEN                                                                                                                                                                    |
| `bash scripts/test-auditoria-recuperacion-cae.sh`                                       | GREEN; recuperación SQL real auditable                                                                                                                                   |
| `bash scripts/test-error-fiscal-no-expuesto.sh`                                         | GREEN; diagnóstico técnico no legible por operadores                                                                                                                     |
| `npx vitest run src/lib/fiscal/feature.server.test.ts src/lib/ventas.functions.test.ts` | GREEN, 19/19                                                                                                                                                             |
| `npm test`                                                                              | GREEN, 79 archivos pasados + 2 omitidos; 1704 pruebas pasadas + 22 omitidas                                                                                              |
| `npm run typecheck`                                                                     | GREEN                                                                                                                                                                    |
| `npm run lint:no-new-debt`                                                              | GREEN, 986 hallazgos actuales / 986 permitidos por identidad exacta; base `1b3bc2c` comparable: 988                                                                      |
| `npm run lint`                                                                          | Ejecutado; ROJO histórico exacto: 986 problemas (977 errores y 9 warnings). El generado queda formalmente excluido; aislado creció 3285 → 3524 errores (+239 mecánicos). |
| `INVOICING_MOCK_MODE=true npm run build:vercel`                                         | GREEN                                                                                                                                                                    |
| Playwright `OK`, spec NC por período, escritorio                                        | GREEN, 5 passed + 2 scenario-skipped, 0 fallos; incluye rango invertido, persistencia flag-off y PDF completo                                                            |
| Playwright `CAIDA_PRE_REQUEST`, spec período                                            | GREEN, 1 passed + 6 scenario-skipped                                                                                                                                     |
| Playwright `TIMEOUT_POST_REQUEST`, spec período                                         | GREEN, 1 passed + 6 scenario-skipped                                                                                                                                     |
| Playwright factura ordinaria aprobada/listado, escritorio                               | GREEN, 2/2; detalle/PDF congelado y búsqueda comprador → receptor                                                                                                        |
| Playwright presupuestos v2                                                              | GREEN, 4/4                                                                                                                                                               |
| `supabase gen types typescript --local` → temporal normalizado + `cmp`                  | GREEN, coincidencia byte a byte                                                                                                                                          |
| `git diff --check`                                                                      | GREEN                                                                                                                                                                    |

La corrida Playwright final fue posterior al reset reproducible. Las historias nuevas usan `vigilarConsola` y terminaron sin errores inesperados. El servidor de desarrollo registra `Failed to fetch` durante la navegación de autenticación anterior al watcher y warnings `DialogDescription` de remitos ya existentes; no hubo 4xx/5xx fiscal ni fallo de producto después de la corrección ACL. El build informa deprecaciones existentes de `inputValidator`, archivos de test ignorados por el router y externalización de módulos Node durante el análisis; la aplicación E2E no produjo el error browser correspondiente.

## Runbook y rollout

- `docs/facturacion-receptor-fiscal-operacion.md` deja el rollout con el flag apagado, smoke ordinario/vinculado, devolución y ajuste por emisor/PV, A/B para RI y C sólo con emisor monotributista configurado.
- La homologación manual debe consultar cada comprobante con `FECompConsultar` y comparar número, CAE, vencimiento, receptor, importes y `PeriodoAsoc` contra request, detalle y PDF; también debe simular timeout posterior y verificar efectos únicos.
- `PeriodoAsoc` usa el certificado WSFE y punto de venta existentes. No requiere ni autoriza crear otro certificado. Se debe validar titularidad, ambiente, servicio, punto de venta y vencimiento en cada entorno.
- El runbook incluye queries de monitoreo para pendientes/reconciliación/bloqueos y discordancias de `nc_efectos_aplicados_at`, rollback sólo por flag y el SQL de activación rotulado **NO EJECUTAR DURANTE LA IMPLEMENTACIÓN**.

## Límites pendientes

- Falta la homologación manual con credenciales ARCA autorizadas y evidencia por cada emisor/punto de venta aplicable. Hasta completarla y obtener aprobación humana separada, producción no está habilitada.
- No se verificó conectividad, certificado, secuencia ni respuesta de ARCA real. El mock demuestra contratos y lifecycle local, no reemplaza homologación.
- El lint global continúa rojo por 986 hallazgos preexistentes fuera del alcance; `lint:no-new-debt` queda como gate reproducible y verde en 986/986.
- No se activó el flag, no se aplicaron migraciones remotas y no se publicó esta rama.
