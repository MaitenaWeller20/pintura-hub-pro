# Ingresos de mercadería desde remito de proveedor — Diseño

**Fecha:** 2026-07-24
**Estado:** Diseño aprobado; pendiente revisión del spec.
**Revisado con:** Codex (crítica de arquitectura incorporada, ver §12).

Feature nueva para el sistema Quimex (pinturería, TanStack Start + React + Supabase/Postgres).

Hoy la usuaria recibe los remitos de sus proveedores **solo en PDF** (o como foto del papel impreso) y los carga a mano, línea por línea. Con Quimexur los códigos del remito coinciden con los suyos y los tipea por código; con KUM los códigos son del proveedor y no coinciden, así que busca cada artículo en el sistema, lo tilda y carga la cantidad. Este diseño automatiza ese circuito: subir el PDF, que se lea solo, revisar, confirmar.

---

## 1. Objetivos y no-objetivos

### Objetivos
- Cargar mercadería a partir del **PDF o la foto** de un remito de proveedor.
- **Extraer** las líneas del documento automáticamente (código del proveedor, descripción, cantidad).
- **Mapear** cada línea a un producto propio, y **aprender** esa equivalencia para que el próximo remito del mismo proveedor venga resuelto solo.
- **Sumar stock** de forma atómica y con kardex, revisable antes de confirmar y reversible después.

### No-objetivos (YAGNI)
- **Plata.** El remito no trae precios (el de Quimexur solo trae un "V.D." declarado; el de KUM no trae un peso). Este circuito **no toca caja ni cuenta corriente de proveedor**. La factura del proveedor se sigue cargando en `/compras`, que es donde vive la deuda.
- **Vincular el remito con la factura** que llegue después. Son dos documentos y hoy nadie los concilia a mano tampoco.
- **Costos o precios desde el remito.** No están en el papel.
- **Actualización de precios** (lista Excel de Quimex, web de KUM). Es un spec aparte.
- **Varios remitos en una sola carga.** Un archivo = un remito (puede tener varias páginas). Los remitos llegan de a uno por WhatsApp.

---

## 2. Principio rector: un remito no es una compra

`crear_compra` existe y funciona, pero **no sirve para esto**: siempre genera impacto financiero — o carga deuda en la cuenta corriente del proveedor, o exige caja abierta y pagos que cubran el total exacto (`20260715110000_crear_compra.sql:146-181`). Cargar un remito por ahí significaría inventar plata que no existe.

Un remito de proveedor es **un aviso de que entró mercadería**. Mueve stock y nada más. Es un circuito nuevo y separado.

Corolario de implementación: **no copiar el trigger de estampado de caja.** `estampar_caja_sesion` (`20260720110000_rediseno_caja_apertura_automatica.sql:117`) se engancha tabla por tabla y auto-abre caja cuando encuentra `caja_sesion_id` en NULL. Las tablas de este circuito **no llevan `caja_sesion_id`** y **no llevan ese trigger**.

---

## 3. Nomenclatura: esto NO se llama "remito"

En este sistema `/remitos` ya significa **transferencia entre sucursales** — la propia UI lo dice: "Remitos internos / Transferencias entre sucursales" (`src/routes/_authenticated/remitos.tsx:76`). Además `REMITO` es un valor del enum de comprobantes de venta. Reusar la palabra garantiza confusión permanente, en el código y en la cabeza de la usuaria.

| Concepto | Nombre |
|---|---|
| UI | **Ingresos de mercadería** |
| Ruta | `/ingresos-mercaderia` |
| Tablas | `ingresos_mercaderia`, `ingreso_mercaderia_items` |
| Nº del papel | `numero_remito_proveedor` |
| Kardex | `INGRESO_MERCADERIA`, `ANULACION_INGRESO_MERCADERIA` |

La palabra "remito" aparece únicamente en textos de pantalla referidos al papel del proveedor ("Nº de remito del proveedor"), nunca como nombre de entidad.

---

## 4. El flujo

```
[1] Subir        PDF o foto (archivo / arrastrar / pegar)
                      ↓
[2] Extraer      Claude lee el documento → JSON validado por Zod
                 Se persiste un BORRADOR antes de llamar al modelo
                      ↓
[3] Matchear     por línea, cortando en el primer acierto:
                 a. equivalencia YA APRENDIDA (proveedor + código) ..... gratis, instantáneo
                 b. código propio exacto — SOLO si el proveedor está
                    marcado como "sus códigos son los míos" ........... Quimexur
                 c. pg_trgm arma lista corta → la IA elige ............. KUM, 1ª vez
                 d. sin match → lo resuelve ella
                      ↓
[4] Revisar      grilla editable; confirmar → RPC transaccional:
                 suma stock + kardex + APRENDE las equivalencias
```

El paso 4 alimenta al 3a: el segundo remito de KUM ya llega resuelto y sin pagar IA de matching. Quimexur nunca llega al paso (c) porque cae en el (b).

---

## 5. Modelo de datos

### 5.1 `proveedores` — columna nueva

```
codigos_coinciden_con_los_propios boolean NOT NULL DEFAULT false
```

**Es el gate del paso 3b y no es opcional.** Los códigos de KUM son numéricos cortos (`86013`, `26301`, `54144`); si alguno coincidiera por casualidad con un código interno, un match automático global metería la mercadería en el producto equivocado **en silencio**. Se prende solo para proveedores donde eso es cierto (Quimexur). Editable únicamente por admin (trigger guard, mismo criterio que `condicion_cta_cte`).

### 5.2 `producto_codigos_proveedor` — la tabla que aprende

`id, proveedor_id, codigo_proveedor (normalizado), producto_id, descripcion_proveedor, usuario_id, created_at, updated_at`

- `UNIQUE (proveedor_id, codigo_proveedor)`.
- **La IA nunca pisa una equivalencia existente.** El upsert es `ON CONFLICT DO NOTHING` salvo que la línea venga con `pisar_equivalencia = true`, que solo puede setearlo el usuario a mano y queda registrado con su `usuario_id`. Sin esta regla, una línea mal matcheada y confirmada envenena todos los remitos futuros de ese proveedor.
- Anular un ingreso **no** borra equivalencias (pueden estar bien aunque el ingreso esté mal). Se corrigen desde la propia pantalla de revisión del siguiente remito, o desde el ABM del producto.

### 5.3 `ingresos_mercaderia`

`id, proveedor_id, sucursal_id, usuario_id, numero_remito_proveedor, numero_normalizado, fecha_remito, fecha_carga, estado, extraccion_estado, extraccion_error, archivo_path, extraccion jsonb, uso_tokens jsonb, idempotency_key uuid, observaciones, created_at`

- `estado`: `BORRADOR | CONFIRMADO | ANULADO`. El stock se mueve **solo** en la transición BORRADOR → CONFIRMADO.
- `extraccion_estado`: `PENDIENTE | OK | ERROR`. El borrador se crea **antes** de llamar al modelo, así una extracción que falla queda visible en vez de evaporarse.
- **UNIQUE parcial** `(proveedor_id, numero_normalizado)` WHERE `estado = 'CONFIRMADO'` — no se carga dos veces el mismo remito. Los borradores no bloquean. El unique es **global por proveedor, no por sucursal**: el mismo papel no entra dos veces aunque sea en sucursales distintas.
- `idempotency_key`: índice único parcial WHERE NOT NULL, igual que `ventas` (`20260718121000_g4_validaciones_crear_venta.sql:20-24`).
- `uso_tokens`: input/output de cada llamada, para saber lo que cuesta esto de verdad.

### 5.4 `ingreso_mercaderia_items`

`id, ingreso_id, producto_id (nullable en BORRADOR), codigo (snapshot), descripcion (snapshot), cantidad, codigo_proveedor, descripcion_proveedor, cantidad_raw, descripcion_raw, pagina, origen_match, confianza`

- `origen_match`: `APRENDIDO | CODIGO | IA | MANUAL | NUEVO | IGNORADA`.
- Los campos `_raw` y `pagina` guardan lo que decía el papel textualmente. Son la defensa contra el problema de la §7 y el material para auditar un ingreso dudoso.
- `producto_id` puede ser NULL mientras el ingreso está en BORRADOR; al confirmar, **toda línea no ignorada debe tenerlo**.

### 5.5 Enum e índices

```sql
ALTER TYPE tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'INGRESO_MERCADERIA';
ALTER TYPE tipo_movimiento_stock ADD VALUE IF NOT EXISTS 'ANULACION_INGRESO_MERCADERIA';
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_prods_nombre_trgm ON productos USING gin (nombre gin_trgm_ops);
```

El índice full-text que ya existe (`idx_prods_nombre`, `to_tsvector('spanish', nombre)`) se queda: sirve para búsqueda por palabras. El de trigramas es para el parecido difuso con abreviaturas ("Esm Sint Sat 4L Negro Victoria"), donde el full-text con stemming español no llega.

### 5.6 Normalización

`numero_normalizado` y `codigo_proveedor` se guardan pasados por una función `normalizar_codigo(text)`: mayúsculas, sin espacios ni guiones, sin ceros a la izquierda, sin acentos. Sin esto, `00054-00023918` y `54-23918` son dos remitos distintos y la unicidad no sirve para nada.

---

## 6. RPCs (SECURITY DEFINER, patrón `crear_venta` / `crear_compra`)

Todas validan `auth.uid()`, validan sucursal propia o admin, y calculan en el servidor todo lo que no debe venir del cliente.

- **`crear_borrador_ingreso(p_proveedor_id, p_sucursal_id, p_archivo_path)`** → crea la cabecera en `BORRADOR` / `PENDIENTE` y devuelve el id. Aplica el **rate limit**: rechaza si el usuario creó más de **30 borradores en la última hora** (el endpoint de extracción gasta plata real por llamada; el contador sale de esta misma tabla, sin tabla extra). 30 es holgado para el uso real —llegan unos pocos remitos por día— y corta en seco un bucle accidental.

- **`guardar_extraccion_ingreso(p_ingreso_id, p_extraccion, p_items, p_uso_tokens, p_error)`** → guarda el resultado del modelo y pasa `extraccion_estado` a `OK` o `ERROR`. Reemplaza los ítems del borrador.

- **`actualizar_items_borrador(p_ingreso_id, p_items)`** → persiste lo que la usuaria va corrigiendo en la grilla. Solo sobre `BORRADOR`.

- **`confirmar_ingreso_mercaderia(p_ingreso_id, p_numero, p_fecha, p_items, p_idempotency_key)`** → el único que mueve stock:
  1. `pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0))` + short-circuit si ya existe.
  2. Lock de cabecera `FOR UPDATE` + guarda de estado (solo desde `BORRADOR`).
  3. Valida: al menos una línea no ignorada; toda línea con `producto_id` y `cantidad > 0`; productos activos; proveedor activo; **ningún `codigo_proveedor` repetido apuntando a dos productos distintos dentro del mismo payload**.
  4. Suma stock con `INSERT ... ON CONFLICT (producto_id, sucursal_id) DO UPDATE SET cantidad = stock_sucursal.cantidad + EXCLUDED.cantidad RETURNING cantidad - v_cant, cantidad` y escribe el kardex en la misma pasada — idéntico a `crear_compra` (`20260715110000_crear_compra.sql:131-144`).
  5. Upsert de equivalencias según §5.2.
  6. Pasa a `CONFIRMADO`.

- **`anular_ingreso_mercaderia(p_ingreso_id)`** → admin. Lock `FOR UPDATE`, guarda de estado, revierte stock validando `cantidad >= a_revertir` salvo `permitir_stock_negativo`, kardex `ANULACION_INGRESO_MERCADERIA`. Mismo patrón que `anular_compra`.

- **`crear_producto_desde_ingreso(p_codigo, p_nombre, p_iva)`** → alta rápida **inactiva** (§8).

- **`buscar_productos_similares(p_texto, p_limite)`** → shortlist por `similarity()` sobre nombre, código y marca.

---

## 7. La capa de IA

Server function `src/lib/ingresos-ia.functions.ts`, con `createServerFn` + middleware `requireSupabaseAuth`, igual que `src/lib/stock.functions.ts`. La `ANTHROPIC_API_KEY` vive **solo** del lado servidor — nunca con prefijo `VITE_`.

- SDK `@anthropic-ai/sdk` (dependencia nueva).
- Modelo por defecto **`claude-opus-4-8`**, configurable por env.
- **Salida estructurada con Zod**: `zodOutputFormat` de `@anthropic-ai/sdk/helpers/zod` pasado como `output_config: { format }` a `client.messages.parse()`, que devuelve `parsed_output` ya validado. Nada de parsear texto libre.
- PDF como content block `document` en base64; fotos como `image`. Los dos nativos, sin librería de OCR.

**Dos llamadas, con presupuestos distintos:**

| | Extracción | Matching |
|---|---|---|
| Entrada | el documento (visión) | texto: líneas sin resolver + su shortlist |
| Modelo | Opus 4.8, `thinking: adaptive` | Opus 4.8, `effort: "low"` |
| Cuándo | siempre | solo si quedan líneas ambiguas |

La segunda no corre nunca para Quimexur (cae toda en el match por código) ni para un KUM ya aprendido. Costo estimado: **US$0,05–0,10 por remito** el primero de un proveedor, la mitad o menos después.

### 7.1 Riesgos de extracción y sus mitigaciones

Estos no son hipotéticos: salen de los remitos reales que mandó el cliente.

| Riesgo | Evidencia | Mitigación |
|---|---|---|
| **Confundir envase con cantidad** | Quimexur: `BASE TINT. ACRIL. EXT. TINTE \| 10 \| LT. \| 1.00` — el "10 LT" es el envase, la cantidad es **1** | El esquema pide `cantidad` y `cantidad_raw` y `descripcion_raw` por separado. Si aparecen números junto a unidades dentro de la descripción, la línea se marca de confianza baja y se resalta en la grilla |
| **Páginas duplicadas** | El PDF de Quimexur que mandaron trae **la misma página dos veces** | Deduplicar por firma de página (hash del texto extraído), **nunca por producto** — dos líneas del mismo producto pueden ser legítimas |
| **Multipágina inconsistente** | — | Cada línea lleva `pagina`. Si el documento tiene dos números de remito o dos fechas distintas, **se bloquea la confirmación** y se pide separar los archivos |
| **Extracción a medias** | — | El borrador se crea antes de llamar al modelo; si falla queda en `ERROR` con el mensaje. No se puede confirmar un ingreso cuya extracción no terminó |
| **Alucinación plausible que el sistema aprende** | — | La IA **propone**; las equivalencias se aprenden solo de lo que la usuaria dejó confirmado, y nunca pisan una equivalencia previa (§5.2) |

---

## 8. Seguridad y permisos

- **Tablas nuevas**: `GRANT SELECT` a `authenticated`, `GRANT ALL` a `service_role`, escritura **exclusiva** por las RPC. RLS por sucursal en la cabecera y por parent en los ítems — mismo criterio que `compras` (`20260715100000_compras_proveedores_schema.sql:112,140`). `stock_movimientos` ya está cerrado a escritura directa (`20260718140000_seguridad_bajas_g6.sql:27`), así que el kardex entra solo por RPC.
- **Quién hace qué**: cualquier usuario autenticado puede subir, revisar y confirmar un ingreso **en su sucursal**; **anular es solo admin**. Es quien recibe la mercadería el que la carga.
- **Producto nuevo inline**: `productos` tiene escritura solo-admin (`20260629211713_...sql:132`), así que el alta va por `crear_producto_desde_ingreso`, SECURITY DEFINER, que un no-admin puede ejecutar pero que **fuerza `activo = false`**. El producto entra al stock pero no aparece para vender hasta que alguien le cargue el precio — imposible venderlo a $0 por descuido. `/productos` gana un filtro "sin precio" para levantar esos pendientes.
- **Archivo**: tipos permitidos (PDF, JPG, PNG, WebP) y tope de **10 MB**, validados en el server function. El límite de la API de Anthropic es 32 MB por request y el base64 infla ~33%, así que 10 MB deja margen de sobra y es enorme para un remito escaneado. Va a un bucket **privado** de Supabase Storage con política por sucursal.
- **Rate limit** de extracciones por usuario/hora dentro de `crear_borrador_ingreso`.

---

## 9. Frontend

- **`/ingresos-mercaderia`** — listado (PageHeader + DataTable + StatusPill por estado), con los borradores arriba para retomarlos. Anular desde acá (admin).
- **`/ingresos-mercaderia/nuevo`** — subir → extraer (con estado de progreso) → revisar → confirmar.
- **Pantalla de revisión** — por línea: lo que dice el papel (código, descripción, cantidad, página), el producto propuesto, de dónde salió el match y la confianza. Acciones: buscar otro producto, crear producto nuevo, ignorar la línea. Las líneas de confianza baja se resaltan. Se guarda solo mientras edita.
- **Sidebar**: bajo el grupo "Compras", junto a `/compras` y `/proveedores`. Regenerar `routeTree.gen.ts`.

---

## 10. Verificación

- **e2e contra la base** (curl a las RPC): confirmar un ingreso suma stock y escribe kardex; el mismo `idempotency_key` dos veces crea **un** ingreso; el mismo remito dos veces rechaza por unique; anular revierte y respeta la guarda de stock negativo; confirmar sin ítems rechaza; una línea sin `producto_id` rechaza; un no-admin no puede anular; `crear_producto_desde_ingreso` siempre deja `activo = false`.
- **Extracción**: correr los cuatro remitos reales del cliente (los dos de Quimexur, incluido el del PDF con la página repetida, y los dos de KUM) y verificar cantidades línea por línea contra el papel. El de Quimexur con `10 LT.` debe dar cantidad **1**.
- **Aprendizaje**: cargar dos veces el mismo remito de KUM (el segundo tras anular el primero) y verificar que la segunda vez matchea todo sin llamar a la IA de matching.
- **typecheck** + tests en verde; regenerar `types.ts`.
- **Review adversarial** + **review con Codex** del diff antes de commitear.
- **Playwright** end-to-end sobre las pantallas nuevas antes de entregar.
- Migraciones a producción (dry-run primero) + deploy, con autorización explícita.

---

## 11. Orden de implementación

1. Migración: extensión, enum, columna en `proveedores`, tablas, índices, normalización, RLS, grants.
2. RPCs: borrador → extracción → items → confirmar → anular → producto inline → búsqueda difusa.
3. Server functions de IA (extracción + matching) con Zod y el manejo de errores.
4. Frontend: listado → alta → pantalla de revisión → sidebar.
5. Verificación (§10), review, commit, producción.

---

## 12. Hallazgos del review con Codex

Incorporados: falta de idempotencia (el repo ya tenía el patrón en `ventas` y este diseño no lo usaba); el match por código exacto no puede ser global; las equivalencias aprendidas pueden envenenarse; crear producto inline choca con el RLS solo-admin de `productos` y con el default de precio 0; el choque de nombres con `/remitos`; validaciones faltantes en la RPC de confirmación; canonicalización de números y códigos; los riesgos concretos de extracción de §7.1.

**Rechazado:** Codex marcó `zodOutputFormat` + `messages.parse()` como "APIs dudosas". Es un artefacto de su corte de conocimiento — son la API actual y documentada del SDK de TypeScript para salida estructurada, y son justamente lo que evita parsear texto libre a mano.

**Devuelto al usuario como decisión suya, no técnica:** Codex recomendó bajar de Opus por costo. Se resolvió diferenciando las dos llamadas (§7): Opus con thinking adaptativo para leer el documento, `effort: "low"` para el matching, y el modelo configurable por env.

---

## 13. Pendiente de confirmar con la clienta

Los remitos de Quimexur vienen a nombre de **Aplicaciones y Servicios S.R.L.** y los de KUM a **Grupo Casa Forma SAS**. Si son dos entidades distintas del mismo grupo, habría que definir si el ingreso necesita registrar a cuál corresponde. **No bloquea la implementación**: hoy el sistema resuelve eso por sucursal, y si hiciera falta se agrega después como un campo en la cabecera.
