# CUIT/DNI canónico en clientes y proveedores

Fecha: 2026-08-11
Estado: implementado. Revisado por Codex sobre el spec y sobre el código.
Pendiente: aplicar la migración a producción y probar en Playwright.

## El síntoma

La clienta intenta crear el cliente "JVS SRL" con CUIT `30715826077` y el sistema
responde **"Ya existe un cliente con ese CUIT/DNI."**. Busca `30715826077` en la
pantalla de Clientes y obtiene **"0 de 1350 — No hay clientes para mostrar."**.

El cartel no miente: el cliente existe. Lo que está roto es que el buscador no lo
encuentra, así que desde la UI el error es indistinguible de un bug y la usuaria
queda trabada sin forma de averiguar quién tiene ese documento.

## Root cause

`clientes.cuit_dni` (y `proveedores.cuit_dni`) guardan el documento en **dos
formatos distintos según quién lo escribió**:

| Origen | Qué queda en la columna |
|---|---|
| Importación de la migración de 3C (~1350 filas) | crudo, como vino del archivo: `30-71582607-7` — `importar-clientes.ts:203` guarda `oNull(cuitBruto)` |
| Formulario de alta/edición | sólo dígitos: `30715826077` — `clientes.tsx:159`, `proveedores.tsx:173` |

Todo lo que **compara** normaliza a dígitos:

- `uq_clientes_cuit_dni_activo` → `ON clientes ((regexp_replace(cuit_dni,'\D','','g')))`
  `WHERE cuit_dni IS NOT NULL AND activo AND regexp_replace(...) <> ''`
- `uq_proveedores_cuit_activo` → predicado idéntico (`compras_proveedores_schema.sql:42`)
- la deduplicación de la importación → `soloDigitos()` (`importar-clientes.ts:119`)
- AFIP → `docTipoAfip`/`docNroAfip` (`fiscal/codigos.ts:230,238`)

Pero todo lo que el usuario **busca y ve** usa el texto crudo. De ahí la
contradicción: `30715826077` colisiona con `30-71582607-7` en el índice
(SQLSTATE 23505) pero no coincide como substring.

Descartado como causa, con verificación independiente de Codex: RLS
(`clientes select` y `prov read` son `USING (true)`), truncado de `traerTodo`
(usa `count: "exact"` y orden estable), y triggers previos (los existentes son
`set_updated_at` y los guards de crédito; ninguno toca `cuit_dni`). El índice
sólo cubre `activo`, así que la fila que choca **está activa y ya está en la
lista que la usuaria tiene en pantalla**, sólo que ilegible para su búsqueda.

### Por qué no alcanza con arreglar el frontend

Normalizar la *consulta* no sirve si la *columna* tiene guiones: `%30715826077%`
nunca va a matchear `30-71582607-7`. En los buscadores server-side el filtro corre
en PostgREST, así que sin tocar la base habría que agregar una columna generada o
un RPC igual. El dato canónico en la base es el arreglo más chico que cubre los
siete buscadores.

## Inventario real de sitios afectados

Corrección a la primera versión del spec, que decía "cuatro buscadores y tres
displays". El cambio de almacenamiento obliga a tocar **todos** los sitios: si se
normaliza el dato y un display no se actualiza, esa pantalla pasa a mostrar
`30715826077` donde hoy muestra `30-71582607-7` — una regresión visible sobre 1350
fichas. No es scope creep, es la consecuencia necesaria del cambio.

**Buscan por `cuit_dni` (7):**

| Lugar | Tipo |
|---|---|
| `clientes.tsx:69` | en memoria |
| `proveedores.tsx:53` | en memoria |
| `cuentas-corrientes.tsx:51` (clientes) | en memoria |
| `cuentas-corrientes.tsx:321` (proveedores) | en memoria |
| `cliente-picker.tsx:40` | PostgREST `.or()` |
| `ventas.nueva.tsx:132` | PostgREST `.or()` |
| `compras.nueva.tsx:110` | PostgREST `.or()` |

**Muestran `cuit_dni` crudo (11):** `clientes.tsx:108`, `proveedores.tsx:100`,
`cuentas-corrientes.tsx:101` y `:339`, `reportes.tsx:234`, `ventas.index.tsx:378`,
`ventas.nueva.tsx:671`, `cliente-picker.tsx:105`, `compras.nueva.tsx:341`,
`pagos-proveedores.tsx:152` (PDF de pago), `fiscal/comprobante-pdf.ts:266` (PDF fiscal).

## Diseño

### 1. Dato canónico: sólo dígitos

Migración `20260811120000_cuit_dni_canonico.sql`, sobre `clientes` y `proveedores`.

**Una sola regla, la misma para el UPDATE y para el trigger:**

> Si el valor **no tiene letras** y contiene **al menos un dígito**, se guardan sólo
> sus dígitos. Si tiene letras, se deja intacto.

Por qué esta regla y no "normalizar todo":

- Resuelve la contradicción que marcó Codex en la v1 del spec: ahí el UPDATE
  preservaba los placeholders (`S/D`) pero el trigger los hubiera pasado a `NULL` en
  la siguiente edición — dos políticas peleadas sobre la misma columna.
- Protege documentos alfanuméricos. Un pasaporte tipo `AAB123456` normalizado a
  `123456` no sólo pierde información: pasa a **poder colisionar** en el índice
  único contra un DNI `123456`. Con la regla de letras, ni se toca.
- Los placeholders legacy (`S/D`, `sin doc`) sobreviven tal cual y siguen fuera del
  índice único, que ya los excluye por `regexp_replace(...) <> ''`.

Implementación: función `public.normalizar_cuit_dni(text)` inmutable con esa regla,
usada por el `UPDATE` de backfill y por un trigger `BEFORE INSERT OR UPDATE` en
ambas tablas. El trigger es la defensa que impide que la columna se vuelva a partir
en dos formatos, venga el dato del formulario, de la importación o de SQL a mano.

**Seguridad de la migración:**

- El `UPDATE` no puede violar el índice único: el índice ya indexa la forma
  normalizada, así que la clave indexada de cada fila **no cambia**. Si dos filas
  activas colisionaran al normalizar, el índice no se habría podido crear.
- Filas inactivas sí pueden compartir documento (el índice las excluye). La
  migración las normaliza sin error, pero **reactivar** una de esas fichas después
  puede fallar con 23505. Es coherente con la intención del índice; queda declarado
  y con un conteo de advertencia en la verificación previa.
- El `UPDATE` masivo dispara `set_updated_at` y mueve el `updated_at` de las filas
  normalizadas. No toca columnas de los guards de crédito, así que no los activa.
  Se acepta explícitamente.
- Idempotente: la segunda corrida no modifica ninguna fila.

### 2. Mostrar con guiones

`src/lib/format.ts` → `fmtDocumento(v)`: 11 dígitos → `30-71582607-7`; cualquier otra
cosa (DNI de 7-8, placeholders, `null`) → tal cual, con `—` para vacío. Se aplica en
**los 11 sitios de display**, PDFs incluidos: guardar canónico no debe empeorar lo
que la clienta ve ni lo que se imprime en un comprobante.

### 3. Buscar por documento aunque se escriba con guiones

Con la columna en dígitos, `30715826077` ya matchea. Falta el caso inverso: quien
escriba `30-71582607-7`. En los siete buscadores, si la consulta tiene dígitos se
busca **también** por su forma normalizada.

**El `.or()` de PostgREST hay que armarlo bien.** Hoy se interpola texto del usuario
crudo en la expresión del filtro (`cliente-picker.tsx:40`, `ventas.nueva.tsx:132`,
`compras.nueva.tsx:110`). Sacar comas y paréntesis —lo que proponía la v1 del spec—
es una mitigación incompleta: `,` `.` `(` `)` `:` son sintaxis de PostgREST y `"`/`\`
rompen el entrecomillado. Hoy mismo un cliente llamado `SANCHEZ, JUAN` rompe la
búsqueda.

Helper `filtroIlikeOr(pares)` en `src/lib/documento.ts` que arma la expresión con el
valor **entre comillas dobles**, que es el mecanismo que PostgREST define para
valores con caracteres reservados. El término de documento se construye con
`soloDigitos()`, así que es `[0-9]*` por construcción y no tiene superficie
sintáctica.

**Hacen falta DOS escapados encadenados, y el orden importa.** Se verificó
levantando un PostgREST real contra la base local y sembrando nombres hostiles.
Con sólo el escapado de PostgREST:

| Consulta | Resultado | |
|---|---|---|
| `SANCHEZ, JUAN` | encuentra la ficha | el bug preexistente, arreglado |
| `EL "PINTOR"` | encuentra la ficha | ok |
| `PAREN(TESIS)` | encuentra la ficha | ok |
| `A_B` | devuelve **3 filas** (`A\B`, `A_B`, `AXB`) | `_` es comodín de LIKE |
| `A\BARRA` | devuelve **0 filas** | `\` es el ESCAPE de LIKE |

Así que primero se escapan los comodines del patrón LIKE (`\` `%` `_` con `\`) y
recién después la gramática de PostgREST. Con los dos, los siete casos dan exacto.

### 4. El error tiene que decir quién

Hoy: *"Ya existe un cliente con ese CUIT/DNI."* — cierto pero inútil, es exactamente
lo que dejó trabada a la usuaria.

Nuevo: ante un 23505 **cuyo mensaje nombre el índice de CUIT** (no cualquier 23505,
que podría venir de otra restricción), se consulta quién tiene ese documento y el
toast dice **"Ya existe un cliente con ese CUIT/DNI: JVS SRL."**. Con la columna
canónica es un `.eq("cuit_dni", cuitNorm)`. Si esa consulta falla o no devuelve nada,
se cae al mensaje actual — el mensaje de error no puede romperse por un error. Como
el índice sólo cubre activos, el texto aclara que la ficha que choca está activa.

Ídem proveedores.

## Alcance

Dentro: la migración (backfill + trigger) en ambas tablas; `fmtDocumento` y su uso en
los 11 displays; `filtroOr` y la normalización de la consulta en los 7 buscadores; el
mensaje de error con nombre en ambos formularios.

Fuera, detectado y anotado pero no se toca acá:

- **CUIL vs CUIT.** `docTipoAfip` etiqueta todo identificador de 11 dígitos como CUIT
  (tipo 80), aunque el PDF ya conoce el tipo 86 = CUIL (`comprobante-pdf.ts:128`). No
  se puede inferir por longitud ni por prefijo; haría falta guardar el tipo de
  documento. Es una decisión de negocio, preexistente y ajena a este bug.
- **DNI con ceros a la izquierda.** `docNroAfip` hace `Number(...)`, que los come
  (`codigos.ts:238`). Preexistente.
- Las otras 4 interpolaciones en `.or()` sobre productos (`presupuestos.nuevo.tsx:78`,
  `presupuestos.editar.$id.tsx:135`, `remitos.tsx:255`) tienen el mismo defecto de
  comillas. `filtroOr` queda disponible para arreglarlas aparte.
- Unificar fichas duplicadas que ya existan.

## Tests

- `fmtDocumento`: 11 dígitos → con guiones; 8 dígitos → tal cual; `null` → `—`;
  placeholder con letras → tal cual.
- `filtroOr`: comas, comillas, backslash, paréntesis, `%`, `_`, vacío.
- Filtro de búsqueda en memoria: consulta con guiones encuentra la fila en dígitos y
  al revés; buscar por nombre sigue andando.
- `normalizar_cuit_dni` (contra la base local): `30-71582607-7` → `30715826077`;
  `S/D` intacto; `AAB123456` intacto; `NULL` → `NULL`; y que el trigger normalice un
  INSERT posterior con guiones, con `activo` true y false.

## Verificación en producción

Antes de aplicar, contar qué se va a tocar, **por tabla**:

```sql
SELECT 'clientes' AS tabla,
       count(*) FILTER (WHERE cuit_dni <> regexp_replace(cuit_dni,'\D','','g')
                          AND cuit_dni !~ '[A-Za-z]')                      AS a_normalizar,
       count(*) FILTER (WHERE cuit_dni ~ '[A-Za-z]')                       AS con_letras,
       count(*) FILTER (WHERE regexp_replace(cuit_dni,'\D','','g') = '')   AS sin_digitos
  FROM public.clientes WHERE cuit_dni IS NOT NULL
UNION ALL SELECT 'proveedores', … ;  -- mismo cuerpo sobre public.proveedores
```

Y los duplicados entre inactivos, que quedarán latentes:

```sql
SELECT regexp_replace(cuit_dni,'\D','','g') d, count(*)
  FROM public.clientes
 WHERE cuit_dni IS NOT NULL AND regexp_replace(cuit_dni,'\D','','g') <> ''
 GROUP BY d HAVING count(*) > 1;
```

**Workaround hasta el deploy:** buscar los 8 dígitos del medio (`71582607`) sí
encuentra la ficha, porque quedan contiguos en el formato con guiones.
