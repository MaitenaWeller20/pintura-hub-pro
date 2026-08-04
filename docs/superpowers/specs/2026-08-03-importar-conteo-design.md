# Importar el conteo de stock desde un archivo

**Fecha:** 2026-08-03
**Estado:** spec
**Pantalla:** `/stock`, modo conteo (`src/routes/_authenticated/stock.tsx`)

---

## 1. El pedido

> "che y en stock hay para importar archivos verdad? cómo quedó eso? debería ser
> una cosa así el doc permitido para la importación… y es más, cargá en la bd
> estos productos al stock porque esto es lo que tienen actualmente"

Y después: *"fijate de entrar a descargas y ahí están y cargá ese stock de cada
uno"*.

Los archivos son dos PDF: el **"Detalle de Existencias al 03/08/2026"** que emite
el sistema viejo de la clienta (3C Informática), uno por depósito.

## 2. Por qué hoy no se puede

Desde el 24/07 hay **un solo camino** que escribe `stock_sucursal`: las RPC que
además escriben kardex. La importación de productos (`/productos/importar`) tiene
prohibido tocar stock, y eso no se negocia — es la corrección del episodio del
envase, con `REVOKE INSERT, UPDATE ON stock_sucursal FROM authenticated` en la
base.

El camino correcto ya existe: el **modo conteo** de `/stock`, que junta un mapa
`producto_id → cantidad` y lo manda a `ajustar_stock_masivo` (atómica, con
kardex, con clave de idempotencia y con `LOCK TABLE`). Lo único que falta es
poder **llenar ese mapa desde un archivo** en vez de tipear 1614 renglones.

O sea: esta spec NO agrega una vía nueva de escritura. Agrega una forma de
llenar un formulario que ya existe.

## 3. Qué traen los archivos (ya verificado)

Se extrajeron los dos PDF y **cuadran contra el total que el propio reporte
imprime en la cabecera del depósito**, que es la mejor suma de control posible:

| | Filas | Con stock | En cero | Suma extraída | Total del reporte |
|---|---|---|---|---|---|
| O'Higgins | 1614 | 853 | 737 | 4421,5 | **4421,5** ✅ |
| "Casa Forma" (Gral Paz) | 1579 | 1049 | 510 | 4764,0 | **4764,0** ✅ |

Hallazgos de calidad de datos, que el diseño tiene que contemplar:

- **Stock negativo**: 24 productos en uno y 20 en el otro, en −1 o −2.
- **Una fila fantasma sin código** en cada archivo (código literal `-`), con
  −202 y −1476. No es un producto.
- **Una cantidad fraccionaria** (0,5) en O'Higgins. Es válida: la tabla es
  `numeric`.
- **Cero códigos duplicados** en los dos archivos.
- Dos familias de código conviven: `1001-00100` y `101.01.001`.

## 4. Decisión de formato: CSV/Excel, no PDF

El PDF se convierte **afuera**, con `scripts/existencias-pdf-a-csv.py`, y a la
pantalla se sube CSV o Excel.

Meter un lector de PDF en el navegador (pdfjs) son ~300 KB de bundle y un parser
de posiciones absolutas —el reporte de 3C no tiene tablas, escribe cada celda en
una coordenada— corriendo en la máquina de la clienta. Todo eso para un formato
que emite un solo sistema. El conversor hace el trabajo sucio una vez, del lado
donde se puede verificar contra la suma de control, y la pantalla recibe algo
simple y auditable.

Además `/productos/importar` ya usa XLSX y acepta `.xlsx/.xls/.csv`: la clienta
ya conoce ese flujo.

## 5. Diseño

### 5.1 Dónde

Botón **"Importar desde archivo"** dentro del modo conteo, al lado de "Guardar
conteo". Fuera del modo conteo no aparece: importar sin haber abierto un conteo
no significa nada (no habría `contado_desde`).

### 5.2 El flujo, en tres pasos

```
[1] Elegir archivo  ──▶  [2] Revisar el resumen  ──▶  [3] Volcar al conteo
                                                              │
                                        (la pantalla de conteo, ya existente)
                                                              │
                                                     [4] "Guardar conteo"
                                                              │
                                                    ajustar_stock_masivo
```

**El paso 3 NO guarda nada.** Vuelca los números en los inputs del conteo, que es
donde la persona los revisa, los corrige a mano si quiere, y recién ahí aprieta
"Guardar conteo". Esto reutiliza entero el camino ya probado y —más importante—
hace que el archivo no sea un acto de fe: se ve producto por producto qué va a
quedar antes de escribir nada.

### 5.3 El resumen (paso 2) es el corazón de la feature

Antes de volcar nada se muestra:

```
Archivo: existencias-ohiggins.csv          Sucursal: CasaForma O'Higgins

  1614  filas leídas
  1580  coincidieron con el catálogo          ← se van a volcar
    34  no están en el catálogo               [ver] [descargar]
     0  códigos repetidos en el archivo       [ver]
     2  cantidades ilegibles                  [ver]
    24  venían en NEGATIVO → se cargan en 0   [ver]

   612  productos del catálogo NO están en el archivo → no se tocan
```

Ninguna de esas líneas es decorativa; cada una es una decisión que se toma sola
si no se muestra:

- **No están en el catálogo**: se saltean. Se pueden descargar en CSV para darlos
  de alta después. Silenciarlos sería perder stock real sin avisar.
- **Repetidos**: se saltean, no se suman ni se pisan. Dos filas del mismo código
  pueden ser "lo conté en dos estanterías" (habría que sumar) o "lo pegué dos
  veces" (habría que ignorar una), y **no hay forma de distinguirlas**. Elegir
  mal duplica stock. Se listan para que la persona arregle el archivo.
- **Negativos → 0**: físicamente no existe tener −1 latas; el negativo del sistema
  viejo significa que se vendió más de lo que tenía registrado. 0 es la mejor
  estimación y es lo que escribiría una persona en la planilla. Pero se avisa
  fuerte, porque esos 44 productos merecen una mirada.
- **Del catálogo que no están en el archivo**: **no se tocan**. Es la decisión
  conservadora: el archivo dice qué hay de lo que lista, no afirma nada sobre lo
  que no lista. Ponerlos en cero por omisión borraría stock por un archivo
  incompleto.

### 5.4 Detección de columnas

Se buscan dos columnas por el encabezado, sin distinguir mayúsculas ni acentos:

| Campo | Encabezados que reconoce |
|---|---|
| Código | `codigo`, `código`, `cod`, `cód. articulo`, `articulo`, `sku` |
| Cantidad | `existencia`, `cantidad`, `stock`, `contado`, `conteo`, `cant` |

Si no las encuentra —o las encuentra mal— hay **dos desplegables para elegirlas a
mano**, precargados con lo detectado. Mismo patrón que `/productos/importar`, que
ya resolvió este problema.

### 5.5 Normalización del código

`trim()` + comparación **sin distinguir mayúsculas**. Nada más.

Explícitamente NO se hace match "flexible" (sacar guiones, puntos, ceros a la
izquierda): `1001-00100` y `101.01.001` son dos familias distintas de códigos que
conviven en el mismo archivo, y aplastarlas aumentaría los matches a costa de
poder asignarle stock al producto equivocado. Un producto sin match se reporta;
un producto con match equivocado se descubre meses después.

### 5.6 Números

Se reutiliza `parseNumAr` de `importar-productos.ts`, que ya sabe el formato
argentino y ya tiene tests. Un decimal como `0,5` tiene que entrar (la tabla es
`numeric` y el archivo real trae uno).

### 5.7 Límites

`ajustar_stock_masivo` topea en **2000 ítems**. Los archivos traen 1614 y 1579,
así que entran — pero el resumen avisa si se pasa, en vez de que el error llegue
del servidor con el conteo ya cargado.

## 6. Lo que NO cambia

- **La RPC.** No hay migración. Cero SQL nuevo.
- **Que sólo las RPC con kardex escriban stock.**
- **Que `/productos/importar` no toque stock.** Sigue prohibido, en la base.
- **El flujo de conteo.** Se le agrega una entrada, no se le cambia la salida.

## 7. El conversor de PDF

`scripts/existencias-pdf-a-csv.py` entra al repo con lo que ya se usó para leer
los dos archivos:

- decodifica los streams (ASCII85 + Flate)
- reconstruye las filas por coordenada (el PDF no tiene tablas)
- **valida contra el total que imprime el reporte** y sale con código ≠ 0 si no
  cuadra

Esa validación es la parte importante: sin ella, un cambio de formato del reporte
produciría un CSV plausible y equivocado.

## 8. Plan de pruebas

**Unitarias** (`src/lib/importar-conteo.ts` + `.test.ts` — la lógica se extrae del
componente para poder testearla):

1. detecta las columnas del CSV real (`codigo` / `existencia`)
2. detecta variantes: `Código`/`CANTIDAD`, `cód. articulo`/`stock`
3. sin encabezado reconocible → no rompe, pide elegir a mano
4. match exacto ignorando mayúsculas y espacios (`" 1001-00100 "` → matchea)
5. NO matchea `1001-00100` con `100100` (nada de match flexible)
6. código que no está en el catálogo → a "no encontrados"
7. código repetido en el archivo → a "repetidos", y **no** se vuelca
8. cantidad negativa → se vuelca **0** y se cuenta aparte
9. cantidad `0,5` → entra como 0.5
10. cantidad vacía / `"-"` / texto → a "ilegibles"
11. fila sin código (la fantasma del PDF real) → se ignora sin contarla como error
12. el conteo de "del catálogo que no vinieron" es correcto
13. más de 2000 ítems → avisa
14. **el archivo real de O'Higgins**: 1614 filas, suma 4421,5

**Del conversor** (`scripts/test-importar-conteo.sh`): correr
`existencias-pdf-a-csv.py` sobre los dos PDF reales y verificar que cuadra; y que
sale con error si se le altera el total.

**Playwright**: abrir conteo en una sucursal, importar un CSV, verificar el
resumen, volcar, comprobar que los inputs quedaron con los números, guardar, y
verificar en la base que el stock y el kardex quedaron bien.

## 9. Review de la spec (Codex)

Diez hallazgos. Los que cambiaron el diseño:

1. **CRÍTICO — nada impedía subir el archivo de una sucursal contando la otra.**
   Serían 1600 cantidades reales escritas en el lugar equivocado. **Corregido**:
   el CSV lleva el depósito, la pantalla muestra lado a lado *"el archivo dice"* y
   *"estás contando"*, y **siempre** exige una confirmación explícita. No se hace
   match automático de nombres a propósito: el depósito de General Paz se llama
   *"Casa Forma"* en el sistema viejo, y cualquier comparación difusa lo casaría
   con *"CasaForma O'Higgins"* — que es justo el error que se quiere evitar.

2. **CRÍTICO — el archivo es una foto, y lo que se movió después se pisa.**
   `contado_desde` protege lo que pasa mientras se cuenta, pero no sabe nada de
   lo ocurrido entre que se sacó la foto y el momento de importar. **Corregido**:
   el CSV lleva la fecha del reporte y la pantalla **cuenta los movimientos
   posteriores de esa sucursal** y los muestra. Si son cero lo dice; si no,
   avisa con el número exacto.

3. **ALTO — "negativos → 0" no puede ser un default silencioso.** Es una
   corrección semántica, no un parseo. **Corregido**: checkbox explícito,
   **apagado por defecto**. Sin tildar, esos productos no se tocan.

4. **MEDIO — "inventario completo" vs "carga parcial" tenía que ser una
   decisión, no un default.** **Corregido**: checkbox, apagado por defecto (lo
   que no está en el archivo no se toca).

5. **MEDIO — los repetidos no deberían pasar como si nada.** Se mantienen fuera
   del volcado y se listan con CSV descargable.

6. **MEDIO — el volcado tiene que ser un solo `setState`.** Confirmado en el
   código: un único `setContado`.

Aceptado sin cambio: el tope de 2000 se **avisa** (los archivos traen 1614 y
1579); soportar 2500 pediría chunking con la misma `contado_desde`, y es una
complejidad que hoy no compra nada. Codex también validó las dos decisiones de
fondo: no hacer match flexible de códigos y no leer PDF en el navegador.

## 10. Verificación

**Unitarias** — 29 tests en `importar-conteo.test.ts` (263 en total, `tsc`
limpio). Incluye uno que corre contra el **archivo real de O'Higgins**: 1614
filas, 0 repetidos, 0 ilegibles, 1 fila fantasma, 23 negativos, y la suma
reconcilia con los 4421,5 que declara el reporte.

**El conversor**, sobre los tres PDF que mandó la clienta:

| Archivo | Páginas | Suma | Resultado |
|---|---|---|---|
| O'Higgins | 1–33 de 33 | 4421,5 = 4421,5 | ✅ escribe el CSV |
| Gral Paz | 1–32 de 32 | 4764,0 = 4764,0 | ✅ escribe el CSV |
| Clientes | **4–40 de 40** | — | ❌ *"FALTAN PÁGINAS: [1, 2, 3]"*, no escribe nada |

Ese tercer caso es el que justifica la validación de páginas: el PDF de clientes
venía sin las tres primeras —110 clientes— y **nada en el archivo lo decía**.

**Playwright**, de punta a punta contra la base local con 330 productos de
códigos reales:

- Se sube el CSV de 1614 filas. Detecta solo las columnas (`codigo`,
  `existencia`), lee el depósito (`O'HIGGINS`) y la fecha (`2026-08-03
  17:33:02`), y confirma que **no hubo movimientos posteriores**.
- El resumen cierra exacto: 296 a cargar + 1313 no encontrados + 4 negativos +
  1 sin código = **1614**.
- `Cargar` queda **bloqueado** hasta confirmar la sucursal.
- Al tildar "negativos como 0" el botón pasa de 296 a **300**.
- Se vuelcan los 300 y los inputs del conteo quedan con los números.
- Se guarda: 1 documento en `stock_conteos`, 300 en `stock_conteo_items`, 123
  movimientos de kardex (sólo los que cambiaron).
- **Comparación producto por producto contra el archivo: 0 diferencias.**


## 11. Review del código (Codex)

Ocho hallazgos. El primero era grave de verdad:

1. **CRÍTICO — `archivoCompleto` ponía en CERO justo lo que la pantalla promete
   no tocar.** El código usaba el conjunto "se pudo volcar" como si significara
   "vino en el archivo". Un producto repetido, ilegible, o negativo sin la tilde
   NO se vuelca — pero SÍ estaba en el archivo. Con "inventario completo"
   prendido, esos caían en la bolsa de "no vinieron" y se escribían en 0.
   Reproducido con un test antes de tocar nada (`B=0`, `C=0` donde no
   correspondía) y corregido separando `vinoEnArchivo` de `yaVolcado`. Cuatro
   tests nuevos lo cubren.

2. **ALTO — las opciones peligrosas sobrevivían al cambio de archivo.** Importar
   un inventario completo, tildar la opción, y después subir un archivo parcial
   dejaba la tilde prendida. Ahora `leerArchivo` resetea las tres.

3. **ALTO — el volcado pisaba valores tipeados a mano sin avisar.** Ahora el
   resumen dice cuántos productos ya tenían un número cargado y se van a
   reemplazar.

4. **ALTO — códigos que sólo difieren en mayúsculas.** El índice del match es
   case-insensitive pero la base sólo garantiza `codigo UNIQUE` sensible a
   mayúsculas: `ABC` y `abc` pueden convivir, y uno pisaría al otro asignando
   stock al producto equivocado. Ahora esas claves se sacan del índice y quedan
   como "no encontrado", que es visible.

5. **MEDIO — la fecha del snapshot iba sin zona horaria.** El reporte lo emite
   una máquina en Argentina y del otro lado hay un `timestamptz`: sin offset,
   Postgres lo leía en UTC y la ventana de "movimientos posteriores" quedaba
   corrida tres horas. El conversor ahora emite `-03:00` explícito.

6. **MEDIO — la query de movimientos no manejaba el error.** Con una fecha
   inválida mostraba "Hubo undefined movimientos". Ahora hay un estado de fallo
   con su propio mensaje.

7. **MEDIO — faltaba índice.** `stock_movimientos` no tenía ninguno por
   `(sucursal_id, created_at)`, y el kardex es la tabla que más crece. Migración
   `20260803210000_indice_movimientos_por_sucursal.sql`.

8. **MEDIO — la suma de control no garantiza el emparejamiento.** Si el parser
   cruzara la cantidad de una fila con el código de otra, el total daría igual.
   Se agregó un chequeo estructural independiente: cuántas celdas cayeron en la
   columna del código contra cuántas filas se extrajeron.

**Verificación posterior a los arreglos**, en el navegador: el aviso de pisado
detecta el valor tipeado a mano, las dos opciones arrancan apagadas, la fecha
sale con `-03:00`, y la pantalla avisa correctamente *"Hubo 123 movimientos de
stock en esta sucursal después de esa hora"* (los del conteo de prueba anterior).
268 tests, `tsc` limpio.