# Importar una lista de clientes

**Fecha:** 2026-08-04
**Estado:** implementado
**Pantalla:** `/clientes` (`src/routes/_authenticated/clientes.tsx`)

---

## 1. El pedido

> "hay que permitir que en clientes se pueda cargar también gente e importar
> también una lista de clientes"

Cargar **a mano** ya existía (botón "Nuevo" con su diálogo). Lo que faltaba es
**importar**: la clienta migra desde 3C Informática con ~1400 clientes.

## 2. Qué se importa, y qué no

Decidido por Leo el 04/08 ("los que están repetidos hay que sacarlos, lista iva
no, cta corriente ns es sí o no, lo del estado no"):

| Columna del reporte | Destino |
|---|---|
| Razón social | `razon_social` |
| CUIT | `cuit_dni` |
| Cta Cte (S/N) | `condicion_cta_cte` (booleano) |
| Domicilio | `direccion` |
| Teléfono | `telefono` |
| Iva (1..6) | **no se importa** |
| Lista (nº de lista de precios) | **no se importa** |
| Estado (H/B) | **no se importa** |

⚠️ **Consecuencia de no importar el IVA**: los 1400 clientes entran como
`CONSUMIDOR_FINAL`, que es el default de la tabla. Eso decide qué comprobante se
les emite, y 1032 de ellos tienen CUIT — o sea que muchos probablemente sean
Responsables Inscriptos. Hay que ajustarlo a mano en los que facturen distinto.
La pantalla lo dice con todas las letras antes de importar.

Consecuencia de no importar el estado: los 19 que en 3C estaban dados de baja
entran activos.

## 3. Diseño

Misma forma que la importación de conteo, porque el problema es el mismo: leer un
archivo ajeno, cruzarlo con lo que ya hay, y **mostrar qué va a pasar antes de
escribir**.

```
[1] Elegir archivo ──▶ [2] Revisar el resumen ──▶ [3] Crear N clientes
```

El riesgo acá no es borrar, es **DUPLICAR**. Un cliente repetido parte su cuenta
corriente y su historial de ventas en dos fichas, y juntarlas después es a mano.
Por eso todo lo dudoso se reporta y no se crea.

### 3.1 Las cinco razones por las que una fila no entra

| Caso | Qué se hace |
|---|---|
| **CUIT/DNI inválido** | se saltea y se reporta para corregir |
| **CUIT repetido en el archivo** | se sacan **todas** sus apariciones |
| **CUIT que ya está en la base** | se saltea (el cliente ya existe) |
| **Nombre que ya está en la base** | se saltea, tenga CUIT o no |
| Sin CUIT, nombre repetido en el archivo | se saltean todas |
| Sin nombre | se ignora |

Con CUIT repetido se sacan **todas** las apariciones y no "la segunda": elegir
cuál de las dos es la buena sería tirar una moneda, y el índice único de la base
(`uq_clientes_cuit_dni_activo`) igual rechazaría a la otra.

El chequeo por **nombre contra la base corre siempre**, tenga CUIT la fila o no.
Ver §6.1: limitarlo a las filas sin CUIT dejaba pasar el caso más probable de la
migración. Frena de más (dos empresas distintas con el mismo nombre) y eso está
asumido: agregar una a mano son dos minutos; fusionar dos fichas con movimientos
no.

### 3.2 El CUIT se compara como lo compara la base

`soloDigitos()` replica exactamente el `regexp_replace(cuit_dni, '\D', '', 'g')`
del índice único. Si se comparara el texto tal cual, `30-12345678-9` y
`30123456789` pasarían como distintos y el INSERT reventaría contra el índice a
mitad del lote.

### 3.3 LA INVARIANTE: el resumen tiene que cerrar

Toda fila leída cae en **exactamente una** categoría:

```
filasLeidas === aCrear + sinNombre + cuitInvalido + cuitRepetido
                       + yaExistenPorCuit + yaExistenPorNombre + nombreRepetido
```

No es decorativo: la primera versión guardaba los nombres repetidos en un `Set`,
así que dos filas escritas **igual** se salteaban las dos pero se listaba una
sola. El resumen decía 1318 leídas y 1316 repartidas, y las 2 que faltaban no
aparecían en ningún lado. Se descubrió sumando las líneas de la pantalla en la
prueba de Playwright. Hay tres tests que sostienen la invariante.

Y volvió a servir después: agregar la categoría "CUIT inválido" a la lógica sin
agregar su línea al resumen dejó otra fila invisible (1318 contra 1317). La misma
suma lo cazó.

### 3.4 Se inserta de a 200

Un INSERT de 1400 filas es un payload enorme y, si falla, no se sabe qué entró.
En lotes, el error dice en cuál se cortó — y como la importación saltea a los que
ya existen por CUIT, volver a correr el mismo archivo **no duplica a nadie**.

## 4. Un bug que salió al paso

`/clientes` traía los clientes con un `select("*")` pelado. PostgREST corta en
**1000 filas y no avisa**: con 1400 clientes la pantalla mostraba 1000 y el resto
desaparecía. Peor para esta feature, que usa esa lista para no duplicar: los que
quedaban afuera se habrían vuelto a crear. Se cambió a `traerTodo`, igual que en
productos y stock.

## 5. El conversor de PDF

`scripts/clientes-pdf-a-csv.py`, hermano del de existencias. La diferencia
importante: **el reporte de clientes no imprime ningún total**, así que no hay
suma de control. La única validación fuerte es que estén todas las páginas — y no
es teórica: el PDF que mandaron el 03/08 arrancaba en la página 4 de 40.

Tiene `--forzar` para escribir igual el CSV de un archivo incompleto (sirve para
cargar lo que hay y completar después, que no duplica), pero avisa fuerte y el
mensaje final cambia a "⚠ INCOMPLETO".

El CSV sale con **todas** las columnas del reporte aunque la importación use
sólo algunas: convertir es una cosa y decidir qué se carga es otra.

## 6. Review del código (Codex)

Ocho hallazgos. Los dos críticos cambiaron la lógica:

1. **CRÍTICO — se duplicaba un cliente que ya estaba SIN CUIT si el archivo lo
   traía CON CUIT.** El chequeo por nombre sólo corría en la rama "sin CUIT". Es
   el caso más probable de esta migración: alguien cargó "ACME" a mano sin CUIT y
   el archivo viejo lo trae con CUIT. Entraba como cliente nuevo y la cuenta
   corriente quedaba partida en dos fichas. **Ahora el nombre se chequea contra
   la base SIEMPRE.** Sí, eso también frena a dos empresas distintas que se
   llamen igual: es el lado barato de equivocarse.

2. **CRÍTICO — el mensaje de reintento mentía.** Decía "no se duplican si volvés
   a importar", pero el diálogo se quedaba con la lista de clientes vieja: para
   los que tienen CUIT el índice único los frena, para los que **no** tienen no
   hay índice y se duplicaban. Ahora `onError` invalida la query, limpia el
   archivo y el mensaje dice exactamente qué pasó y qué hacer.

3. **ALTO — la importación no validaba el CUIT y el alta a mano sí.** Se guardaba
   cualquier cosa con dígitos, y encima cualquier dígito hacía esquivar el
   chequeo por nombre. Ahora usa `validarCuitDni`, la misma del alta manual.
   Sobre el archivo real: **1 de 1099** falla (un CUIT de 10 dígitos), así que
   validar no cuesta nada y atrapa justo el que está mal.

4. **ALTO — `traerTodo` avisa `truncado` y se estaba ignorando.** Si la lista de
   existentes viene incompleta no se puede chequear duplicados: ahora bloquea.

5. **ALTO — el botón Importar no era sólo de admin.** El trigger
   `guard_clientes_credito` impide que un empleado cree clientes con cuenta
   corriente, así que a mitad del lote se cortaba con un error de permisos.

6. **MEDIO — al elegir otro archivo quedaban a la vista el resumen y el botón del
   anterior.** Ventana corta, pero alcanza para importar el equivocado.

7. **MEDIO — el conversor descartaba en silencio** las filas sin código legible.
   Como este reporte no tiene total de control, eso era un cliente que
   desaparecía sin rastro. Ahora las cuenta y las reporta. (Sobre el archivo
   real: cero.)

8. **Test con falso verde**: la invariante del archivo real usaba
   `toBeLessThanOrEqual`, justo lo contrario de "exactamente una categoría" —
   permitía que una fila desapareciera y el test siguiera verde. Ahora es exacta.

## 7. Verificación

22 tests unitarios (287 en total, `tsc` limpio), incluidos tres de la invariante
y dos contra el archivo real.

**Playwright**, con los 1318 clientes reales del archivo de la clienta:

- Detecta las cinco columnas solo.
- El resumen **cierra exacto**: 1246 a crear + 67 CUIT repetido + 0 ya existentes
  + 1 nombre ya existente + 4 nombre repetido = **1318**.
- Los 67 son las apariciones de **33 CUIT distintos** — los mismos 33 que se
  habían detectado leyendo el PDF.
- Se crean los 1246. En la base: **0 CUIT duplicados**, 198 con cuenta corriente
  (`S` → `true`, `N` → `false`), 466 con domicilio y los dobles espacios del PDF
  colapsados.
- La lista muestra los 1249 sin truncar, o sea que el paginado del punto 4 anda.

**Y la prueba que más vale — reimportar el MISMO archivo sobre la base que ya los
tiene:**

```
1318  filas leídas
   0  se van a crear          ← no duplica a nadie
   1  con el CUIT/DNI inválido
  67  con el CUIT repetido en el archivo
1031  ya están en el sistema (mismo CUIT)
 215  con un nombre que ya existe en el sistema
   4  sin CUIT, con el nombre repetido en el archivo
```

Cierra exacto y el botón queda deshabilitado. Esa segunda pasada es la que
demuestra que la deduplicación anda de verdad, y de paso valida el camino de
"cargá lo que hay y completá después".

Nota: agregar la categoría "CUIT inválido" a la lógica sin agregar su línea al
resumen dejó **una fila invisible** — 1318 leídas contra 1317 mostradas. Lo
detectó la invariante, otra vez, en la prueba de Playwright.
