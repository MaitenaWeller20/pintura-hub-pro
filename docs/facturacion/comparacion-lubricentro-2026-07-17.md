# Facturación electrónica: lubricentro vs Quimex — qué portar

> Inspección comparativa del código real de ambos sistemas (2026-07-17).

He leído el código fiscal real de Quimex (`fiscal.functions.ts`, `fiscal/arca.ts`, `fiscal/codigos.ts`). Todo lo que sigue está anclado a lo que hay hoy en el repo, no a la spec. Un hallazgo importante: **la MEJORA 3 no es una mejora a agregar, es un bug vivo en Quimex** — te lo marco abajo con línea y todo.

---

# 1. Tabla comparativa

| Capacidad fiscal | Lubricentro | Quimex | Nota |
|---|---|---|---|
| Pedido de CAE (FECAESolicitar) | Sí | **Sí** | Paridad. `arca.ts:181` |
| Detección de rechazo con CAE vacío | Sí | **Sí** | `arca.ts:264`. El cheque está |
| **Extraer el MOTIVO real del rechazo (códigos AFIP)** | Sí | **No (bug)** | Quimex lee `r.observaciones ?? r.errores`, claves inexistentes → siempre cae al genérico. `arca.ts:259-270` |
| Anti-duplicación (getLastVoucher en el medio) | Sí | **Sí** | `fiscal.functions.ts:400-433` |
| Recuperación por timeout (FECompConsultar) | Sí | **Sí** | `fiscal.functions.ts:363-398` |
| Clasificación transitorio vs negocio | Sí | **Sí** | `arca.ts:80`. Cert NO transitorio, igual criterio |
| Outbox durable con máquina de estados | Sí (`EmisionFiscal`) | **No** | Quimex reserva el número en la fila `ventas` + índice único |
| Claim atómico / grace period anti-concurrencia | Sí | **Parcial** | El índice único cubre dos ventas distintas, NO el doble-click de la MISMA venta (ver §3.4) |
| Fallback "cobrar sin factura / facturar después" | Sí (feature) | **N/A** | En Quimex venta y emisión ya están desacopladas: es estructural |
| **Selector Factura A/B (RI→B a cliente RI)** | Sí (server-auth) | **No** | `determinarLetra` siempre da A para RI+RI. `codigos.ts:54` |
| **Validar CUIT (dígito verificador) antes de Factura A** | Sí (`cuitValido`) | **Parcial** | Quimex sólo exige 11 dígitos (`docTipoAfip!==80`), no corre el módulo 11. `fiscal.functions.ts:339` |
| Exigir CUIT en el registro según condición | Sí (`assertDocParaCondicion`) | **Parcial** | `validarCuitDni` existe para el form, pero no fuerza CUIT para RI/Mono/Exento |
| Matriz A/B/C server-authoritative | Sí | **Sí** | `codigos.ts:54` |
| RG 5616 (CondicionIVAReceptorId) | Sí | **Sí** | `codigos.ts:190` |
| QR RG 4892 | Sí | **Sí** | `qr.ts`, `fiscal.functions.ts:563` |
| NC/ND con CbtesAsoc | Sí | **Sí** | `fiscal.functions.ts:314-331` |
| Clase C sin IVA discriminado | Sí | **Sí** | `TIPOS_C`, `codigos.ts:98` |
| Percepciones como ImpTrib (Id 99) | Sí | **Sí** | `arca.ts:231-243` |
| Redondeo una vez por ítem | Sí | **Sí** | `iva.ts` |
| Fechas fiscales en TZ Argentina | Parcial (bug `toISOString`) | **Sí (mejor)** | `fecha.ts`. Quimex corrige el bug de lubri/MesaYa |
| Verificación cert↔clave falla cerrado | No (salteaba) | **Sí (mejor)** | `cert.ts:95` |
| Aviso de vencimiento de certificado | Sí | **Sí** | `fiscal.functions.ts:58-60` |
| TA WSAA persistido | MemoryTicketStorage (RAM) | **Supabase cifrado + L1 (mejor)** | Sin tormenta de logins. `ticket-storage.ts` |
| Cifrado AES-256-GCM de secretos | Sí | **Sí** | `crypto.ts` |
| **Fallback de clave para rotar `ARCA_ENCRYPTION_KEY`** | Sí (commit cec2429) | **No** | Quimex hoy: rotar la key ⇒ hay que rehacer el trámite AFIP |
| Modo MOCK / demo | Sí | **Sí** | `arca.ts:21` |
| PV y modo por sucursal | Config del emisor | **Sí, por sucursal (más granular)** | `puntos_venta` |
| Documentos internos que NO van a AFIP | — | **Sí (explícito)** | `TIPOS_INTERNOS`, `codigos.ts:32` |
| Aislamiento RLS + service_role + IDOR | Sí | **Sí** | `admin()`, lectura RLS de la venta |
| Reconciliación de huérfanos / carga manual PDF | Sí | **No** | — |
| HUB /facturacion (solo lectura) + emisiones a revisar | Sí | **No** | — |
| Libro IVA | Sí | **No** (fuera del módulo fiscal) | — |
| RG 5762 (A con leyenda) | Sí | **No** | Probablemente innecesario para pinturería |

---

# 2. Lo que Quimex ya tiene igual o mejor (no reescribir)

- **TA persistido cifrado en Postgres** (`SupabaseTicketStorage`): mejor que el Map-en-RAM de lubri, que genera tormenta de logins (`coe.alreadyAuthenticated`) en cada cold start. Compartido entre instancias serverless, con L1 en RAM.
- **Fechas fiscales en TZ `America/Argentina/Buenos_Aires`** (`fecha.ts`): corrige el bug de `toISOString().slice(0,10)` de lubri/MesaYa que te corría una venta de las 21:30 al período de IVA siguiente.
- **Verificación cert↔clave que falla cerrado** (`cert.ts:95`): compara el módulo RSA; lubri salteaba esta verificación.
- **Durabilidad por timeout ya resuelta**: reserva del número en la fila `ventas` + índice único `uq_ventas_afip_numeracion` + recuperación con `consultarComprobante` (`fiscal.functions.ts:363-462`). Cubre el huérfano por timeout post-envío sin el peso del outbox.
- **"Último local" contado sólo sobre filas con CAE** (`.not('cae','is',null)`) + liberación del número en rechazo de negocio (`afip_numero=null`, `:523`): evita trabar el contador para siempre. Es exactamente el criterio correcto.
- **Detección de CAE vacío** (`arca.ts:264`): el cheque más importante está (lo que falta es extraer el motivo — MEJORA 3).
- **`alicuotaValida` con guard de 0%** (`codigos.ts:129`): ya trae incorporada la lección del bug de lubri (`Number(x) || 21` colapsa el 0% legítimo).
- **Clase C, percepciones ImpTrib 99, redondeo por ítem, RG 5616, QR RG 4892, CbtesAsoc, MOCK, PV/modo por sucursal, aislamiento RLS/IDOR**: paridad, ya portados y explícitos.

---

# 3. Mejoras a portar (ordenadas por valor/esfuerzo)

## 3.1 — MEJORA 3: Mostrar el motivo real del rechazo de AFIP ⚠️ ES UN BUG VIVO
**Qué es / qué resuelve.** Cuando AFIP rechaza, el SDK resuelve OK con `cae` vacío; el motivo (`[10016] El CondicionIVAReceptorId no se corresponde…`, `[10013]`, etc.) viene en `result.response`, NO en el primer nivel. Hoy Quimex hace:
```js
// arca.ts:259-270
const r = result as { cae?; caeFchVto?; observaciones?; errores? };
const obs = r.observaciones ?? r.errores;   // <- SIEMPRE undefined
```
`observaciones`/`errores` no existen en la respuesta del `@arcasdk/core` → `obs` es siempre `undefined` → **todo rechazo cae al genérico "Revisá los datos fiscales e intentá de nuevo"** y el código de AFIP se pierde también en los logs (`fiscal.functions.ts:502` sólo loguea el mensaje genérico). Es el mismo bug que lubri ya arregló.

**Cómo está en lubri.** `detalleRechazoAfip(response)` (arca-afip.ts:346-362) junta `response.Errors.Err[]` (nivel request) + `response.FeDetResp.FECAEDetResponse[].Observaciones.Obs[]` (por comprobante) como `[código] mensaje`. Loguea el motivo, NO la response cruda (que trae CUIT/DocNro del receptor).

**Cómo encaja en Quimex.** Reescribir el bloque `arca.ts:259-270`: leer `result.response`, construir `detalleRechazo(response)` con el mismo join `[código] mensaje`, tirarlo en el `throw` y loguearlo. Como es rechazo de negocio, `emitirComprobante` ya lo guarda en `afip_error` y libera el número (`:521-524`) — sólo cambia que ahora `afip_error` tendrá el código real. No dumpear `JSON.stringify` crudo (privacidad del receptor).

**Esfuerzo: chico.** ~1 función + 5 líneas. **Riesgo: bajo.** Es puramente el mensaje de error; no toca el happy path.

---

## 3.2 — MEJORA 2: Validar CUIT (dígito verificador) antes de Factura A
**Qué es / qué resuelve.** Hoy Quimex sólo chequea que el doc tenga 11 dígitos:
```js
// fiscal.functions.ts:339
if (letra === "A" && docTipoAfip(cuitCliente) !== 80) throw ...
```
Un CUIT de 11 dígitos con verificador MAL pasa este guard y se lo come AFIP con un `10013/10016` críptico, quemando un ida-y-vuelta a AFIP y dejando un número reservado que hay que liberar.

**Cómo está en lubri.** `assertReceptorFacturaA(letra, tipoDoc, nroDoc)` (arca-afip.ts:141-155) exige `DocTipo 80` + `cuitValido` (módulo 11) y tira un mensaje accionable: *"corregí el documento a CUIT o cambiá la condición a Consumidor Final para emitir Factura B"*.

**Cómo encaja en Quimex.** El helper **ya existe**: `cuitValido` en `codigos.ts:155`. Reforzar el guard de `fiscal.functions.ts:339` para exigir además `cuitValido(cuitCliente)` y mejorar el mensaje (ofrecer la salida por Factura B). Quimex tiene un único chokepoint (`emitirComprobante`), así que no hace falta el patrón "en cada punto + backstop" de lubri: se toca un solo lugar. Complemento opcional: en el registro del cliente, exigir CUIT válido para RI/Monotributo/Exento (hoy `validarCuitDni` valida forma pero no fuerza CUIT según condición).

**Esfuerzo: chico.** Reforzar un `if` + mensaje. **Riesgo: bajo.** Ya estás 80% ahí.

---

## 3.3 — MEJORA 1: Selector Factura A/B (RI puede emitir B a cliente RI)
**Qué es / qué resuelve.** Un emisor RI que le vende a un cliente RI a veces quiere emitir **Factura B (Consumidor Final)** en vez de A. Hoy `determinarLetra` fuerza A sin escapatoria (`codigos.ts:54-61`).

**Cómo está en lubri.** `puedeForzarConsumidorFinal(flag, condEmisor, condReceptor)` (arca.ts:32-34): server-authoritative, sólo `true` si emisor **y** receptor son RI (para CF/Mono/Exento el flag se ignora, el hidden input es manipulable). Cuando aplica, la condición efectiva del receptor pasa a CONSUMIDOR_FINAL (→ letra B, `CondicionIVAReceptorId=5`) manteniendo el documento; y **congela** la elección en la fila con un claim atómico para dos clicks concurrentes, y todos los reintentos la LEEN en vez de re-derivar.

**Cómo encaja en Quimex.** Acá hay una ventaja: `venta.tipo_comprobante` **ya distingue** `FACTURA_A` vs `FACTURA_B` y ya está persistido, así que sirve de portador de la intención sin agregar columna. Pasos:
1. En `codigos.ts`, agregar `puedeForzarConsumidorFinal(condEmisor, condReceptor)` (sólo RI+RI).
2. En la orquestación (`fiscal.functions.ts:307-343`): si el usuario eligió `FACTURA_B` sobre un receptor RI y la función lo permite, `condReceptor := CONSUMIDOR_FINAL` **antes** de `determinarLetra` (server-authoritative: sólo se permite el "downgrade" A→B, nunca al revés). Eso arrastra letra B y `CondicionIVAReceptorId=5` solo.
3. **Consistencia con la NC** (el punto fino): hoy la NC deriva su letra de `letraDeFactura(orig.tipo_comprobante)` (`:328`). Si forzás B sobre una venta tipada `FACTURA_A`, la NC saldría A contra una factura B. Solución limpia: derivar la letra de la NC desde `orig.afip_cbte_tipo` (que **ya está persistido** y es la letra real: 1→A, 6→B, 11→C) en vez de `tipo_comprobante`. El QR ya usa `afip_cbte_tipo`, así que la impresión queda consistente sola.

**Esfuerzo: medio.** Toca el núcleo de determinación de letra + un ajuste en NC + un control en la UI. **Riesgo: medio.** Es el corazón fiscal; el server-authoritative y el punto (3) son innegociables para no descuadrar Libro IVA/NC.

---

## 3.4 — Guard anti doble-submit (grace / in-flight) — el subset del outbox que sí vale
**Qué es / qué resuelve.** Hay una **carrera real** hoy: dos requests para la MISMA venta (doble click / retry) sin `afip_numero` previo → ambos pasan el cheque `venta.cae`, ambos calculan `numero = ultimoAfip+1` (el mismo), y ambos hacen `update ventas … where id=venta.id`. Como es **la misma fila**, el índice único `uq_ventas_afip_numeracion` NO los frena (sólo frena dos ventas *distintas* peleando un número) → **ambos llaman `solicitarCae(N)`**: doble envío a AFIP. El índice único te cubre el caso de ventas distintas, no el doble-click de una.

**Cómo está en lubri.** `GRACE_MS=30s` + claim atómico `updateMany where estado=esperado` (emision-fiscal.ts:23-27, :181-211): un intento reciente en curso se trata como "esperá y verificá", no re-emite.

**Cómo encaja en Quimex (sin el outbox completo).** No hace falta portar `EmisionFiscal`. Alcanza con un claim atómico en la reserva: convertir el `update` de reserva (`:446-456`) en condicional — reservar sólo si `afip_estado` NO está `PENDIENTE` con `afip_intentos` reciente, o agregar un `where` que exija transición de estado (p.ej. `.neq('afip_estado','PENDIENTE')` + un timestamp de gracia). Si el claim afecta 0 filas → "emisión en curso, esperá y reintentá". Reusa `afip_estado`/`afip_intentos`/`afip_emitido_at` que ya existen.

**Esfuerzo: chico-medio.** **Riesgo: bajo-medio** (hay que testear el reintento legítimo post-timeout, que SÍ debe poder re-entrar tras el grace).

---

## 3.5 — Fallback de clave para rotar `ARCA_ENCRYPTION_KEY` (bonus barato, alineado con seguridad pendiente)
**Qué es / qué resuelve.** Hoy `decryptString` (`crypto.ts`) tira si la key cambió (bien, sin null silencioso), pero **no soporta dos claves** → rotar `ARCA_ENCRYPTION_KEY` deja el cert indescifrable y hay que rehacer el trámite AFIP. Tu `MEMORY.md` tiene "rotar secretos quimex" como pendiente de seguridad; esto lo destraba.

**Cómo está en lubri.** Commit cec2429: `decryptString` prueba la clave nueva y cae a la anterior (`ARCA_ENCRYPTION_KEY_OLD`), permitiendo rotar sin re-importar.

**Cómo encaja en Quimex.** En `crypto.ts`, `decryptString` intenta con la key primaria y, si falla, con `ARCA_ENCRYPTION_KEY_PREVIOUS`; sigue tirando si fallan las dos (no regresás la propiedad "fail loud"). Re-cifrás en caliente al leer. **Esfuerzo: chico. Riesgo: bajo** (bien testeado).

---

## 3.6 — Opcionales de menor prioridad
- **HUB de facturación + "emisiones a revisar"** (lubri `facturacion.ts`): una vista solo-lectura de pendientes (`afip_estado='PENDIENTE'/'ERROR'`) y de reservas viejas sin CAE (huérfanos peligrosos). Datos ya los tenés en `ventas.afip_*`. **Medio / riesgo bajo.** Sube visibilidad operativa.
- **Libro IVA** (lubri `contabilidad.ts:621`): suma por tipo/naturaleza excluyendo anuladas con **total firmado** (NC en negativo, mismo criterio de signo en todos lados). **Medio / riesgo bajo.**
- **Outbox completo `EmisionFiscal` / reconciliación de huérfanos / RG 5762**: **diferir.** Para Quimex el outbox es **grande** y de valor incremental bajo — la venta ya es el anclaje natural de idempotencia (a diferencia de la `VentaDirecta` de lubri que no existe antes de AFIP). La reconciliación sólo se justifica si te comés un incidente real de huérfanos; RG 5762 probablemente no aplica a una pinturería.

---

# 4. Recomendación: qué encarar primero

**1) MEJORA 3 — motivo real del rechazo (§3.1). Primero y ya.** No es una mejora, es un bug: hoy *cada* rechazo de AFIP en Quimex sale genérico y sin código, tanto para el usuario como en los logs. Es media hora de trabajo, riesgo nulo, y sin esto vas a estar debuggeando a ciegas los rechazos de las otras dos mejoras. Es el que más te desbloquea.

**2) MEJORA 2 — CUIT con verificador antes de Factura A (§3.2).** Chica, riesgo bajo, y ya estás 80% ahí (`cuitValido` existe, sólo hay que enchufarlo en `fiscal.functions.ts:339`). Mata una clase entera de rechazos crípticos `10013/10016` antes de tocar AFIP y le da al usuario una salida accionable.

**3) MEJORA 1 — selector Factura A/B (§3.3).** Es la única de las tres con valor *comercial* directo (poder emitir B a un cliente RI) y la que el negocio va a pedir. Es medio y toca el núcleo, así que va tercera: hacela **después** de tener la 3 andando (para ver el motivo si algo se rechaza) y cuidá el punto de la NC (derivar letra de `afip_cbte_tipo`, no de `tipo_comprobante`).

**Bonus para meter en el mismo PR de las chicas:** el **fallback de clave** (§3.5) — es barato y está alineado con tu pendiente de rotación de secretos en `MEMORY.md`. Y dejá anotado el **guard anti doble-submit** (§3.4) como el único hueco de integridad real que te queda (la carrera del doble-click sobre la misma venta), para cuando tengas aire: no urge, pero es el que algún día te va a duplicar un comprobante.

El **outbox completo NO lo portes**: para Quimex es esfuerzo grande y valor bajo porque la reserva-en-la-fila + `consultarComprobante` ya te cubren el huérfano por timeout, que era el 90% del problema que el outbox resuelve en lubri.