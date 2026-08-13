# El stock no es el envase — Diseño

**Fecha:** 2026-07-24
**Estado:** Implementado y verificado en local (unit + e2e SQL + Playwright). Spec revisado con
Codex (§12); código revisado con Codex (§13) y con agentes adversariales (§14). Pendiente:
deploy a producción.
**Reportado por:** la clienta (capturas de `/stock` y `/productos` del 24/07).

---

## 1. El síntoma

En **Inventario** (`/stock`) la columna **Cantidad** muestra `20,00`, `200,00`, `1,00`, `4,00`…
Esos números no son stock: son el **tamaño de envase** de cada producto (la columna `ENV.`
de la lista de precios de Quimexur). La clienta lo marcó textualmente: _"Eso es ENV"_
sobre la columna Cantidad de Inventario, y _"Acá está bien"_ sobre la columna **Env.** de
`/productos`.

Contrastado contra la lista real (`LP N° 125 - Quimexur (12-6-2026).xlsx`, solapa
`LISTA PLANA`):

| Código       | Descripción             | ENV. (Excel) | Cantidad en `/stock` |
| ------------ | ----------------------- | ------------ | -------------------- |
| `1000-02000` | SOL MEX SOLVENTE BLANCO | 20           | 20,00                |
| `1000-20000` | SOL MEX SOLVENTE BLANCO | 200          | 200,00               |

Coincidencia exacta, fila por fila. El inventario de producción está cargado con el envase.

Y la frase que cierra el diagnóstico: **"el stock en realidad se carga aparte"**. La lista de
precios es una lista de **precios**; el stock entra por otro lado (ajuste, ingreso de
mercadería, compra). Nunca por la planilla de precios.

---

## 2. La causa raíz

`/productos/importar` ofrece dos destinos de mapeo, **"Stock O'Higgins"** y
**"Stock General Paz"** (`productos.importar.tsx:46-47`), y cuando están mapeados escribe:

```ts
await supabase.from("stock_sucursal").upsert(
  { producto_id: up.id, sucursal_id: …, cantidad: stockOhi },
  { onConflict: "producto_id,sucursal_id" },
);
```

Tres defectos en cuatro líneas:

1. **Pisa el stock en absoluto.** Reimportar la lista de precios —cosa que se hace cada vez
   que Quimexur actualiza— resetea el inventario al valor de la planilla.
2. **No deja kardex.** Es la única escritura de `stock_sucursal` del sistema que no pasa por
   una RPC y no escribe `stock_movimientos`. El resto (`crear_venta`, `crear_compra`,
   `ajustar_stock`, `aprobar_remito`, `confirmar_ingreso_mercaderia`) siempre audita. La
   propia migración de borrado de productos ya tuvo que documentar la excepción:
   _"Excel/seed cargan stock sin kardex → 'sin historial' no implica 'sin stock'"_
   (`20260724130000_eliminar_productos.sql:89-90`).
3. **Invita al error.** La lista de Quimexur **no trae stock**. Sus únicas columnas son
   `CÓDIGO`, `DESCRIPCIÓN`, `ENV.`, `PRECIO DE LISTA` y `Sugerido al público C/IVA`. Frente a
   un desplegable "Stock O'Higgins" vacío, la única columna numérica sin usar es `ENV.`.

**El auto-mapeo no es el culpable.** Verificado ejecutando `autoMapear()` contra los headers
reales de las cuatro solapas: `ENV.` cae siempre en `tamano_envase` (match exacto, `env`), y
`stock_ohi`/`stock_gpz` quedan **sin mapear** (ningún header contiene `ohi` ni `gpz`). El
mismo resultado da la versión anterior a R8. O sea: el `ENV. → Stock` se eligió **a mano** en
el desplegable de la pantalla de mapeo. Que se pueda elegir a mano es exactamente el bug.

---

## 3. Principio rector

> La importación de la lista de precios actualiza **precios y datos del producto**.
> **Nunca toca el stock.** El stock se carga aparte y siempre con kardex.

Es lo que dice la clienta y es lo que ya cumple todo el resto del sistema.

---

## 4. Alcance

### Objetivos

1. Que la importación de la lista **no pueda** escribir stock — ni desde la pantalla ni desde
   PostgREST.
2. **Corregir el dato ya cargado** en producción: la fila cuyo stock es en realidad el envase
   vuelve a su último valor auditado (0 si nunca tuvo uno), con respaldo por fila para poder
   deshacerlo.
3. Que en `/stock` se **vea** el envase al lado de la cantidad, para que la confusión no se
   repita de un vistazo.

### No-objetivos (YAGNI)

- **Un importador de stock masivo.** Si algún día hace falta cargar inventario desde una
  planilla, es una feature aparte: pantalla propia, columna de stock explícita, y una pasada
  por `ajustar_stock` (RPC, con kardex y motivo) por fila. Hoy no existe esa necesidad: el
  stock entra por Ingresos de mercadería, Compras y el Ajuste de `/stock`.
- **Tocar Ingresos de mercadería.** Ese circuito ya trata el envase como riesgo explícito
  (`riesgoEnvaseCantidad`, §7.1 del spec de ingresos) y su cantidad viene del remito, no de
  la lista.
- **Recalcular stock histórico.** No hay forma de reconstruir qué había realmente; el stock
  real lo carga ella.

---

## 5. Fix A — la importación deja de tocar stock

- El mapeo de columnas sale de la ruta y pasa a **`src/lib/importar-productos.ts`**
  (`FIELDS_TARGET`, `SINONIMOS`, `normalizar`, `parseNumAr`, `numOr`, `autoMapear`,
  `detectarFilaEncabezados`), para poder testearlo. Es la parte de la importación que más veces
  se equivocó y cada error corrompe el catálogo entero de un saque.
- De `FIELDS_TARGET` y `SINONIMOS` desaparecen los destinos `stock_ohi` y `stock_gpz`.
- En `src/routes/_authenticated/productos.importar.tsx` se elimina el bloque de `upsert` sobre
  `stock_sucursal` (y la consulta de `sucursales`, que queda sin uso).
- La pantalla lo dice: **"Esta importación actualiza precios y datos del producto. No toca el
  stock: el stock se carga desde Ingresos de mercadería, Compras o el ajuste de Inventario."**

`stock_minimo` **se queda**: es un atributo del producto (el umbral de alerta), no inventario.

Consecuencia deseada: después de esto, la única forma de que `stock_sucursal` cambie es una
RPC que escribe kardex. La excepción documentada en `eliminar_productos` deja de generarse
hacia adelante (el comentario se mantiene, porque el dato viejo sigue existiendo).

---

## 6. Fix B — corrección del dato en producción

Migración nueva: `20260724150000_corregir_stock_cargado_como_envase.sql`.

### 6.1 Cómo se reconoce una fila contaminada

La clave está en que **la importación escribía `stock_sucursal` sin dejar kardex**. Por lo
tanto, en una fila contaminada, la última escritura de la tabla **no** tiene un movimiento que
la respalde. `stock_sucursal.updated_at` (trigger `trg_stock_upd` → `set_updated_at()`, que
usa `now()`) y `stock_movimientos.created_at` (`DEFAULT now()`) se escriben con el **mismo**
timestamp de transacción cuando la escritura viene de una RPC. O sea:

| Última escritura de la fila                      | Relación                                                  |
| ------------------------------------------------ | --------------------------------------------------------- |
| Una RPC (venta, compra, ajuste, ingreso, remito) | `updated_at = max(mov.created_at)`                        |
| La importación de la lista                       | `updated_at > max(mov.created_at)` (o no hay movimientos) |

El predicado, entonces:

```sql
p.tamano_envase IS NOT NULL AND p.tamano_envase <> 0
AND s.cantidad = p.tamano_envase                     -- la firma del ENV
AND (ult.ultimo_at IS NULL OR s.updated_at > ult.ultimo_at)  -- último write sin kardex
AND NOT EXISTS (SELECT 1 FROM stock_correccion_envase c …)    -- no corregida ya
```

Esto es **estrictamente mejor** que "no tiene movimientos": atrapa también la fila que tenía
historial legítimo y **después** fue pisada por la importación (un `upsert` absoluto pisa
igual una fila con kardex). Ese caso, con el predicado ingenuo, quedaba sin corregir
justamente en los productos más operados.

### 6.2 A qué valor se vuelve

**No a 0 siempre**: se vuelve al **último valor auditado** — la `cantidad_nueva` del
movimiento de kardex más reciente de ese par (producto, sucursal). Si nunca hubo movimientos,
ese valor es 0. Así, una fila que tenía 7 unidades reales, fue pisada con 20 (el envase) y no
volvió a moverse, vuelve a 7 y no a 0.

### 6.3 Ambigüedad: cuándo NO tocar

Si el movimiento de kardex más reciente de un par (producto, sucursal) **empata en
`created_at` con otro** —una venta con el mismo producto en dos líneas escribe dos movimientos
con el mismo `now()` de transacción—, no hay forma determinística de saber cuál fue el último:
`stock_movimientos.id` es un `gen_random_uuid()`, no un orden temporal. Desempatar por `id`
devolvería un valor u otro al azar.

Esas filas se **saltean** y se informan por `NOTICE` con su cantidad. Dejar un valor mal es
preferible a restaurar otro peor, y se arreglan con el ajuste de `/stock`.

### 6.4 Respaldo y reversa

Tabla nueva `public.stock_correccion_envase`, una fila por corrección:

`producto_id, sucursal_id, producto_codigo, producto_nombre, sucursal_codigo,
cantidad_anterior, cantidad_nueva, tamano_envase, stock_updated_at, ultimo_movimiento_at,
movimientos_count, motivo, revertido_at, created_at` con `UNIQUE (producto_id, sucursal_id)`.

Cumple tres funciones a la vez:

1. **Es el informe.** Queda la lista exacta de qué se tocó y con qué contexto, consultable
   después del deploy (no un `NOTICE` que se pierde en los logs).
2. **Es la reversa.** `supabase/snippets/revertir-correccion-envase.sql` restaura
   `cantidad_anterior` fila por fila, con la guarda de no pisar una fila que se movió después
   de la corrección, y **marca** `revertido_at` en vez de borrar la fila.
3. **Es la guarda de idempotencia.** Correr la migración dos veces no vuelve a tocar nada.

Dos detalles que parecen menores y no lo son:

- **Las filas de esta tabla nunca se borran.** Son la guarda de idempotencia: si se borrara la
  fila después de revertir, un replay de la migración volvería a ver `cantidad = envase` con
  `updated_at` posterior al último movimiento y "corregiría" de nuevo, deshaciendo la reversa.
- **Las FK van `ON DELETE SET NULL`, no `CASCADE`, y el código/nombre se guardan
  desnormalizados.** Con `CASCADE`, borrar el producto se llevaba puesto el registro de
  auditoría; con una FK restrictiva, el registro impediría borrar el producto (el mismo
  problema que el kardex, §6.5). `SET NULL` + desnormalización deja las dos cosas sanas.

### 6.5 Antes del push: el diagnóstico

`supabase/snippets/diagnostico-stock-envase.sql` es **sólo lectura** y muestra contra
producción, antes de aplicar nada: cuántas filas se corrigen, cuántas se saltean por
ambigüedad, cuántas quedan intactas, el detalle fila por fila con el valor al que quedaría
cada una, y un control de sanidad (¿hay algo de stock que **no** sea el envase?).

### 6.6 Por qué NO se escribe kardex

Tentador, pero está mal por dos razones:

- **Rompería el borrado de productos.** `eliminar_productos` (`20260724130000:77-95`) toma
  `EXISTS stock_movimientos` como "tiene historial" y en ese caso **archiva en vez de borrar**.
  Un movimiento artificial dejaría a los ~121 productos contaminados imposibles de borrar de
  verdad, para siempre, por un dato que nunca existió. La FK de `stock_movimientos.producto_id`
  además bloquearía el `DELETE`, así que no habría forma de arreglarlo después.
- **Mentiría.** Un `AJUSTE -20` dice "salieron 20 unidades del depósito". No salió nada: nunca
  entraron. Es una reparación de dato, no un movimiento de mercadería, y el lugar honesto para
  registrarla es la tabla de respaldo. De paso no inunda los 500 movimientos recientes de
  `/reportes`.

### 6.7 Concurrencia

`LOCK TABLE public.stock_sucursal IN SHARE ROW EXCLUSIVE MODE` al principio del bloque: si
alguien está vendiendo mientras corre el `db push`, la corrección y la venta se serializan en
vez de pisarse.

### 6.8 Lo que la clienta va a ver

Las ~121 filas corregidas pasan a 0 (o a su último valor auditado). Como `stock_minimo` es 0,
`/stock` las va a mostrar como **"Sin stock"** y el KPI de **stock bajo** del dashboard las va
a contar. Es la verdad —no hay stock cargado—, y se resuelve sola a medida que ella carga el
inventario real. Hay que avisarlo para que no parezca un segundo bug.

---

## 7. Fix C — que el envase se vea en Inventario

`/stock` gana una columna **"Env."** entre Producto y Sucursal, con el mismo formato que
`/productos` (`p.tamano_envase ?? "—"`). Dos motivos:

- La clienta identificó el problema justamente porque conocía los valores de ENV. Tenerlos al
  lado de la cantidad hace evidente cuándo se están confundiendo.
- Es información útil por sí sola: "tengo 3" significa cosas muy distintas en un envase de 1 L
  y en uno de 200 L.

Se agrega también al PDF de `Imprimir` de esa pantalla, para que el papel y la pantalla digan
lo mismo. La query de `/stock` ya trae el producto embebido: sólo hay que sumar
`tamano_envase` al `select`.

---

## 8. Seguridad y permisos — se cierra la vía de escritura sin kardex

Sacar el código de la importación no alcanza: `stock_sucursal` todavía tiene
`GRANT SELECT, INSERT, UPDATE … TO authenticated` y la policy `"admin write stock"`
`FOR ALL` (`20260629211713:145,149`). Cualquier admin puede seguir escribiendo stock directo
por PostgREST — una pestaña vieja con el bundle anterior, un `curl`, o el próximo atajo. El
bug puede reaparecer el mismo día del deploy.

Se cierra, igual que se hizo con `stock_movimientos` en G6 (`20260718140000`):

```sql
REVOKE INSERT, UPDATE ON public.stock_sucursal FROM authenticated;
DROP POLICY IF EXISTS "admin write stock" ON public.stock_sucursal;
-- se conserva "auth read stock" (FOR SELECT): /stock, dashboard y ventas leen esta tabla
```

Verificado que no rompe nada: **todas** las funciones que escriben stock son `SECURITY
DEFINER` con owner `postgres` (`crear_venta`, `anular_venta`, `crear_compra`, `anular_compra`,
`aprobar_remito`, `ajustar_stock`, `confirmar_ingreso_mercaderia`,
`anular_ingreso_mercaderia`), así que ignoran grants y RLS. Y en `src/` no queda ninguna
escritura directa a la tabla después del Fix A (`stock.functions.ts` va todo por RPC).
`service_role` conserva `GRANT ALL`.

Después de esto, la invariante es real y no sólo una convención: **`stock_sucursal` sólo
cambia por una RPC que escribe kardex.**

---

## 9. Verificación

- **Unit tests** (`vitest`) sobre el mapeo de la importación, extrayendo `normalizar`,
  `autoMapear` y `sinonimos` a un módulo testeable (`src/lib/importar-productos.ts`):
  - los headers reales de `LISTA PLANA` y `LISTA ACTUALIZACIÓN` mapean `ENV. → tamano_envase`;
  - **ningún** destino de mapeo escribe stock (la lista de `fieldsTarget` no contiene claves
    de stock de sucursal);
  - se conservan los casos que ya estaban cubiertos de hecho: el `Sugerido al público C/IVA`
    no se engancha a `iva_porcentaje`, y `parseNumAr` con formato argentino/inglés.
- **e2e contra la DB local** (SQL), con los casos que importan de verdad:

  | #   | Escenario                                                                                     | Esperado                                                                               |
  | --- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
  | a   | `cantidad = envase`, sin ningún movimiento                                                    | → 0, respaldada                                                                        |
  | b   | `cantidad = envase`, con movimientos y **la importación después** (`updated_at > último mov`) | → vuelve a la última `cantidad_nueva` auditada, respaldada                             |
  | c   | `cantidad = envase`, y el **último write fue una RPC** (`updated_at = último mov`)            | intacta                                                                                |
  | d   | `cantidad ≠ envase`, sin movimientos                                                          | intacta                                                                                |
  | e   | `tamano_envase` NULL (productos del seed) con stock sin kardex                                | intacta                                                                                |
  | f   | `tamano_envase = 0`                                                                           | intacta                                                                                |
  | g   | correr la migración **dos veces**                                                             | la segunda no toca ni respalda nada                                                    |
  | h   | tras corregir, `eliminar_productos` sobre un producto contaminado                             | se **borra** (no quedó kardex artificial)                                              |
  | i   | un `authenticated` admin intenta `UPDATE stock_sucursal` directo                              | rechazado                                                                              |
  | j   | `ajustar_stock` (RPC **de verdad**) sobre un producto con `cantidad = envase`                 | deja kardex **y** `updated_at = created_at`: la premisa de §6.1 verificada, no asumida |
  | j2  | correr la corrección después de (j)                                                           | esa fila **no** se toca                                                                |
  | k   | el último movimiento **empata** en `created_at` con otro                                      | se saltea y se informa                                                                 |
  | l   | el mismo producto en **dos sucursales**, una contaminada y otra sana                          | sólo se corrige la contaminada                                                         |
  | m   | el último movimiento tiene `cantidad_nueva` NULL                                              | vuelve al último valor **no nulo**                                                     |
  | n   | se borra el producto después de corregirlo                                                    | el respaldo **sobrevive** (FK `SET NULL` + desnormalización)                           |

  El script (`scripts/test-correccion-envase.sh`) primero **verifica que la migración esté
  aplicada entera** (tabla + `REVOKE` + policies), y extrae el bloque de corrección del archivo
  de migración real —exigiendo que haya exactamente uno— para no probar una copia
  desincronizada.

- **typecheck** + suite completa en verde.
- **Review adversarial** con subagentes + **review con Codex** del diff.
- **Playwright** en local, con la lista real (`LP N° 125 - Quimexur`, solapa LISTA PLANA,
  1103 filas). Resultado medido:
  - la pantalla de mapeo **no ofrece** ningún destino de stock, y `ENV.` cae en "Envase (ENV)";
  - la importación crea los 1103 productos con su envase y sus precios;
  - `stock_sucursal` queda **idéntico** — 60 filas, total 1171, con el `max(updated_at)`
    anterior a la importación;
  - cargando stock real por RPC, Inventario muestra `Env. 20 → Cantidad 3` y
    `Env. 200 → Cantidad 1`: las dos columnas, distintas y al lado;
  - el PDF de Inventario sale con las 7 columnas alineadas (verificado extrayendo su texto) y
    sin errores de consola.
- **Deploy** (cuenta "poldo", con autorización explícita). El `db push` aplica **todas** las
  migraciones pendientes y la corrección destructiva es la última de la fila, así que hay que
  mirar las dos puntas:
  1. `supabase migration list --linked` — ver exactamente qué queda pendiente. Si hay
     migraciones anteriores sin aplicar y alguna falla, el push aborta y la corrección **no
     corre**, pero el frontend sí se deploya: quedaría la importación arreglada y el dato de
     stock sin corregir.
  2. Correr `supabase/snippets/diagnostico-stock-envase.sql` contra prod y **guardar la salida**
     (la lista de códigos, no sólo los contadores).
  3. `db push --dry-run --linked` → `db push --linked`.
  4. Verificar **después** del push, contra prod:

     ```sql
     SELECT count(*) AS filas_corregidas,
            sum(cantidad_anterior - cantidad_nueva) AS unidades_retiradas
       FROM public.stock_correccion_envase WHERE revertido_at IS NULL;

     SELECT has_table_privilege('authenticated','public.stock_sucursal','UPDATE') AS puede_escribir,
            (SELECT count(*) FROM pg_policies
              WHERE schemaname='public' AND tablename='stock_sucursal') AS policies;
     -- esperado: puede_escribir = f, policies = 1 ("auth read stock")
     ```

  5. `vercel --prod --yes`.

---

## 10. Orden de implementación

1. Extraer el mapeo a `src/lib/importar-productos.ts` + tests (rojo → verde).
2. Fix A: sacar los destinos de stock de la importación y el `upsert`.
3. Fix B: la migración de corrección + su test e2e local.
4. Fix C: columna Env. en `/stock` y en su PDF.
5. Verificación (§9), reviews, commit, producción.

---

## 11. Riesgo asumido y cómo se comunica

Queda un falso positivo posible: un producto que **realmente** tenga tantas unidades como
litros/kilos su envase (1, 4, 20, 200 son cantidades plausibles) y cuya última escritura de
stock no tenga kardex. Con el predicado de §6.1 eso exige que ese stock real se haya cargado
por fuera de toda RPC —o sea, por la misma importación rota, o por el `ajusteStock` viejo de
antes del 2026-07-14, que hacía read-modify-write en tres statements sueltos y podía dejar
stock sin kardex si fallaba el `INSERT` del movimiento (`20260714260000:4-12`)—, así que la
intersección es chiquita.

Es **destructiva pero reversible**: la tabla de respaldo tiene el valor anterior de cada fila y
el snippet de reversa lo restaura una por una. Y antes de aplicar nada, el diagnóstico de §6.5
muestra la lista exacta contra producción.

Lo que sí hay que **avisar**: después del deploy el inventario va a mostrar esos productos en
0 / "Sin stock" y el KPI de stock bajo del dashboard va a saltar. Es correcto —no hay stock
cargado— y se normaliza cuando ella cargue el inventario real.

---

## 12. Hallazgos del review del SPEC con Codex

**Incorporados:**

1. _El predicado "sin movimientos" no alcanza_ — un `upsert` absoluto pisa igual una fila que
   ya tenía kardex, así que los productos más operados quedaban sin corregir. Reemplazado por
   la comparación `updated_at` vs `max(mov.created_at)` (§6.1) y la vuelta al último valor
   auditado en vez de 0 (§6.2).
2. _Falta rollback durable_ — `RAISE NOTICE` + kardex no es un respaldo. Agregada la tabla
   `stock_correccion_envase` y el snippet de reversa (§6.3).
3. _El diseño no cerraba la vía de escritura sin kardex_ — `stock_sucursal` seguía escribible
   directo por PostgREST para admins. Agregado el `REVOKE`/`DROP POLICY` y el `LOCK TABLE`
   durante la corrección (§8, §6.5).
4. _La interacción con eliminar-productos estaba al revés_ — no es que se borrarían de más:
   escribir kardex los volvería **imposibles de borrar** para siempre. Eso cambió la decisión:
   **no se escribe kardex** (§6.4).
5. _Tests demasiado cómodos_ — la tabla de casos de §9 pasó de 3 a 10, con los escenarios
   peligrosos (import posterior a movimientos, rerun, efecto sobre eliminar-productos, el
   REVOKE).
6. _Efecto en `/stock` y dashboard_ — documentado en §6.6 y §11 para avisarlo, no para
   ocultarlo.

**Matizado:** Codex pidió frenar el `UPDATE` hasta que producción confirme un CSV de
candidatos. No se hace como bloqueo previo: el respaldo por fila (§6.3) da la misma
reversibilidad sin dejar el inventario roto mientras tanto, y la lista queda disponible en la
tabla de respaldo apenas termina el deploy.

---

## 13. Hallazgos del review del CÓDIGO con Codex

**Incorporados:**

1. **CRÍTICO — el "último valor auditado" no era determinístico.** El desempate
   `ORDER BY created_at DESC, id DESC` usaba un `gen_random_uuid()` como si fuera un orden
   temporal. Una venta con el mismo producto en dos líneas escribe dos movimientos con el
   mismo `created_at`: podía restaurar 8 en vez de 5, al azar. Ahora esas filas se **saltean**
   y se informan (§6.3), con test propio (escenario k).
2. **CRÍTICO — el predicado prueba "hubo un write sin kardex", no "fue la importación".** Es
   cierto: el `ajusteStock` viejo (anterior a `20260714260000`) también podía dejar stock sin
   kardex. Se documenta como riesgo asumido (§11) y se mitiga con el diagnóstico previo (§6.5)
   y el respaldo reversible (§6.4), en vez de bloquear la corrección.
3. **IMPORTANTE — el test podía dar falso verde.** Sólo corría el bloque `DO` (no el
   `CREATE TABLE`, ni los grants, ni el `REVOKE`), y el chequeo de permisos dependía de que la
   migración ya estuviera aplicada. Ahora el script **verifica esa precondición explícitamente**
   y exige que la migración tenga exactamente un bloque `DO`.
4. **IMPORTANTE — la reversa tenía una instrucción invertida y peligrosa.** Decía borrar la
   fila de respaldo después de revertir, lo que dejaba a un replay de la migración
   "corrigiendo" de nuevo lo revertido. Ahora se **marca** `revertido_at` y nunca se borra.
5. **IMPORTANTE — el spec se contradecía.** Decía "vuelve a 0 con kardex y motivo" (el diseño
   final no escribe kardex) y "no es destructivo" (lo es: destructivo _reversible_). Corregido.
6. **MENOR — el respaldo se perdía al borrar el producto** (FK `ON DELETE CASCADE`). Ahora las
   FK van `ON DELETE SET NULL` y el código/nombre quedan desnormalizados, así el registro
   sobrevive sin impedir el borrado (escenario n).

**Verificado y sin cambios:** Codex confirmó que ninguna RPC deja `updated_at` distinto de
`created_at` (todas usan `now()` en la misma transacción) — además lo verifica ahora un test
con una RPC real (escenario j); que el `REVOKE` no rompe escrituras desde `src/`; que perder
`.select().single()` en el upsert de productos no cambia el manejo de errores; y que la aridad
de columnas de `/stock` y de su PDF es correcta.

---

## 14. Hallazgos del review adversarial con subagentes

Cinco revisores en paralelo (predicado, permisos, regresiones de la importación, UI/coherencia,
tests y reversa), cada hallazgo verificado por dos agentes independientes —uno tratando de
refutarlo, otro midiendo la consecuencia—: **26 hallazgos crudos → 4 confirmados** más 5 del
crítico de completitud. Los agentes reprodujeron los dos primeros contra la DB local, no los
dedujeron.

**Confirmados e incorporados:**

1. **CRÍTICO — el desempate por uuid restauraba un valor INTERMEDIO.** Ya lo había marcado
   Codex (§13.1) y estaba mitigado saltando las filas ambiguas. Los agentes lo **reprodujeron**
   sobre la versión anterior: 6 corridas del mismo dataset dieron `15, 10, 10, 10, 15, 15` —
   3 de 6 perdían 5 unidades de mercadería realmente recibida. Confirmado que la versión con
   exclusión por ambigüedad es estable: 8 de 8 corridas dejan la fila intacta.
2. **IMPORTANTE — la guarda de ambigüedad no cubría el camino del `cantidad_nueva` NULL.**
   Detectaba empates en `max(created_at)` de **todos** los movimientos, pero el objetivo sale
   sólo de los que traen snapshot: un último movimiento sin snapshot hacía "no ambigua" a una
   fila cuyo objetivo caía en un empate anterior. Reproducido. Ahora la ambigüedad se evalúa
   sobre el mismo conjunto del que sale el objetivo, y también se saltea la fila que tiene
   kardex pero **ningún** snapshot (no hay valor al que volver). Escenarios `o` y `p`.
3. **CRÍTICO — el test podía terminar en verde con el escenario del `REVOKE` en rojo.** Ese
   bloque —el único que verifica toda la §8— usaba `psql` crudo sin `ON_ERROR_STOP`, que
   devuelve 0 aunque el SQL tire `ERROR`. Ahora usa `$PSQL` como el resto.
4. **CRÍTICO — el snippet de reversa mandaba borrar el respaldo.** Mismo hallazgo que §13.4,
   confirmado desde otro ángulo (y con el detalle extra de que el `DELETE` filtraba sólo por
   `producto_id`, borrando el respaldo de las dos sucursales).
5. **IMPORTANTE — la reversa marcaba `revertido_at` en filas que no revirtió.** El paso 2 tenía
   la guarda `updated_at <= created_at` y el paso 3 marcaba con otro filtro: una fila salteada
   quedaba marcada como revertida y, como el paso 2 exige `revertido_at IS NULL`, no se podía
   revertir nunca más. Reproducido. Ahora restaurar y marcar van en **un solo statement**
   encadenado por CTE, y el paso 1 tiene una columna `estado` que dice si es revertible.
6. **IMPORTANTE — nadie iba a ver las filas contaminadas sobre las que ya se operó.** Una venta
   posterior a la importación rota cambia la cantidad y deja kardex, así que la fila deja de
   cumplir el predicado y la migración no la toca (correcto), pero tampoco aparecía en ningún
   informe. El diagnóstico gana la consulta **4**, que las encuentra por su firma dura: un
   movimiento cuyo `cantidad_anterior` es exactamente el tamaño de envase.
7. **MENOR — el diagnóstico sobre-contaba `se_corrigen`**: no aplicaba el filtro
   `anterior <> objetivo` que sí aplica la migración, así que el número que se iba a mirar con
   la clienta no era el que iba a salir. Corregido, con una columna
   `ya_estaban_en_el_valor_correcto` para que cierre.
8. **MENOR — al plan de deploy le faltaban las dos puntas** (`migration list` antes,
   verificación después). Incorporado en §9.

**Descartados (22):** entre ellos, que el `REVOKE` rompiera alguna RPC (todas son
`SECURITY DEFINER`), que el módulo extraído no fuera equivalente al original, que perder
`.select().single()` cambiara el manejo de errores, y que la aridad de columnas de `/stock`
estuviera mal.
