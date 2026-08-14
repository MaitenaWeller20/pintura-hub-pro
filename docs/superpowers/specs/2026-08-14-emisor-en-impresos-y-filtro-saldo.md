# Datos del emisor en los impresos, y filtro por saldo en cuentas corrientes

**Pedidos de Leo (13/08/2026):**

> - Que en cuentas corrientes me deje filtrar por los que tienen saldo para pagar.
> - Que en los presupuestos y facturas que imprimimos salgan los datos como celular,
>   dirección. Por lo menos la dirección y el celular, no hace falta el mail. Lo del
>   logo lo puedo pedir o que lo suban ellos si lo dejamos como parte de alguna
>   configuración en el sistema.

| Sucursal | Razón social | Dirección | Celular |
| --- | --- | --- | --- |
| General Paz | Aplicaciones y Servicios SRL | Sarmiento 1398 - B° Gral Paz - Córdoba | 3513229459 |
| O'Higgins | Grupo Casa Forma SAS | O'Higgins 5450 - Córdoba | 3512146766 |

> **v2** — reescrita después del review de Codex, que rechazó la v1. Qué cambió, en §7.

---

## 1. Lo que hay hoy

Los dos PDF ya leen el emisor de `fiscal_config` (`presupuestos.$id.tsx:84-96`,
`comprobante-pdf.ts:206-217`), pero **`fiscal_config` está vacío en producción**:
todo NULL y `habilitada = false`. Por eso los impresos salen pelados. Ninguno
imprime teléfono: el campo no existe ahí.

`sucursales` ya tiene `direccion` (con relleno) y `telefono` (NULL).

## 2. Son dos contribuyentes, no dos direcciones

Una **SRL** y una **SAS** son dos personas jurídicas distintas: tienen CUIT
distinto por definición. Esto no es una duda, es un dato.

`fiscal_config.id` es un `boolean` — una sola fila, un solo emisor. No alcanza.

La v1 proponía meter `razon_social` y `cuit` como columnas de `sucursales` y
dejar el modelo para cuando llegue el certificado. **El review lo rechazó y tiene
razón**: el modelo no depende del certificado, y postergarlo obliga a rehacer
emisión, puntos de venta, snapshots y reimpresiones bajo presión el día que AFIP
se habilite. Se hace ahora.

## 3. El modelo

**`emisores`** — quién factura. Una fila por persona jurídica.

- `razon_social`, `cuit`, `domicilio_fiscal`, `condicion_iva`,
  `ingresos_brutos`, `inicio_actividades` (todo nullable menos la razón social:
  hoy sólo se conoce el nombre y el domicilio).
- `logo` — data URL, ver §5.3.

**`sucursales.emisor_id`** — de qué emisor es cada local. Y `direccion` /
`telefono` se quedan donde están: son datos de **contacto del local**, no de la
persona jurídica.

Como cada sucursal pertenece a exactamente un emisor, el encabezado nunca puede
mezclar la razón social de uno con el teléfono del otro — que era un agujero real
de la v1.

**`fiscal_config` no se toca.** Sigue siendo el singleton de credenciales de AFIP
(certificado, clave), hoy vacío. Cuando llegue el certificado hay que moverlas a
1:1 por emisor y revisar `puntos_venta`, que hoy tiene `UNIQUE(numero, modo)`
atado sólo a sucursal (`20260713122000_facturacion_electronica.sql:85-97`) y le
impediría a dos CUIT usar el mismo número de punto de venta, cosa perfectamente
posible. **Va al backlog con esa cita.**

## 4. Qué imprime cada documento

| Documento | Encabezado |
| --- | --- |
| **Factura CON CAE** | **Sólo el snapshot.** Nunca datos actuales |
| Factura sin CAE / documento interno | Emisor de la sucursal, con la marca de "no fiscal" que ya lleva |
| Presupuesto | Emisor de la sucursal + dirección y celular del local |
| Remito interno | Emisor de la sucursal de **ORIGEN**, que es quien remite |

La primera fila es la corrección más importante del review. Una factura
autorizada tiene que reimprimirse **igual que salió**, y para eso está
`afip_snapshot`, que ya existe y ya se usa (`fiscal.functions.ts:794`). Agregarle
un fallback dinámico —como proponía la v1— haría que una factura vieja cambiara
de emisor el día que se configure AFIP.

**Agujero preexistente que esto NO arregla:** las facturas emitidas antes de que
existiera el snapshot releen la config actual al reimprimirse
(`fiscal.functions.ts:790-806`). No se toca acá porque hoy `fiscal_config` está
vacío y no hay ninguna factura con CAE real; se anota en el backlog.

## 5. Los cambios

### 5.1 Filtro por saldo (independiente, va primero)

Un selector **Todos · Con deuda · A favor**, con **Todos por defecto**.

La v1 proponía "Con deuda" por defecto y el review lo objetó bien: la pantalla es
la cuenta corriente general, no una pantalla de cobranzas, y esconder por omisión
a los que están en cero produce "desapareció el cliente". Leo pidió *poder*
filtrar, no que viniera filtrado.

**El umbral va en 0, no en 0,01.** La v1 decía que 0,01 era "el mismo criterio que
ya usa la pantalla para pintar el número" — y es falso: con `> 0.01` un saldo de
exactamente un centavo se muestra como `$0,01` y no entra en ninguno de los dos
filtros. Los movimientos son `numeric(14,2)`
(`20260713140000_cta_corriente_libro_movimientos.sql:28-32`), así que no hay
fracciones de centavo que amortiguar: se compara contra 0 sobre el saldo
redondeado a dos decimales.

Y se muestra el total de lo filtrado, con el nombre que corresponde: "total a
cobrar" en deuda, "total a favor" (en positivo) en la otra.

### 5.2 Datos del emisor

Migración con la tabla, la FK, y **los datos reales cargados** (van en la
migración y no a mano en producción, para que local y prod queden iguales y quede
asentado de dónde salieron).

El presupuesto hoy trae sólo `sucursal(nombre)` (`presupuestos.$id.tsx:55-60`):
hay que ampliar la consulta o el PDF no tiene de dónde sacar los datos. Lo mismo
en el listado de ventas (`ventas.index.tsx:91-94`) y en el remito.

### 5.3 El logo

Data URL en `emisores.logo`, subible desde `/facturacion`, que ya es una pantalla
de admin con su server function (`guardarConfigFiscal`).

El review propuso un bucket de storage. Se queda en columna, pero con las
salvaguardas que marcó, que eran el punto real:

- **Nunca en una consulta de listado.** Se pide sólo al generar un PDF, así que no
  viaja en cada carga de pantalla ni se queda en la caché de react-query.
- **Tope de 100 KB** ya en base64 (no 200 KB de binario, que en base64 son 267).
- **Se validan los bytes, no el MIME declarado**: que empiece con la firma de PNG
  o JPEG. Y las **dimensiones**, que es lo que hace pesado al PDF: máximo
  1000×1000, y se reescala en el navegador antes de guardar.
- PNG/JPEG únicamente. Nada de SVG.

El bucket que existe (`remitos-proveedor`) no servía sin cambios: es privado y sus
policies son por sucursal, no para un activo de marca
(`20260724120000_ingresos_storage_bucket.sql:10-34`).

### 5.4 Editarlos

Sección nueva en `/facturacion`. La v1 decía "editables desde la pantalla de
Sucursales" y **esa pantalla no existe**; encima `sucursales` sólo tiene policy de
lectura (`20260629211713…sql:35-39`), así que no había forma autorizada de tocar
esos campos. Va con server function de admin.

### 5.5 El encabezado tiene que medir

El bloque del emisor tiene alto fijo de 40 mm (`comprobante-pdf.ts:179-228`). Con
logo, teléfono y una razón social larga se puede pisar el bloque del receptor. Se
mide y se reserva alto en vez de asumirlo.

## 6. Pruebas

- **Unitarias**: precedencia del encabezado —que una factura con CAE salga del
  snapshot y **no** de los datos actuales, que sin CAE salga el emisor de la
  sucursal— y que el encabezado no se pise con una razón social larga + logo.
- **SQL**: que la migración deje cada sucursal con su emisor.
- **E2E**: el filtro (que "Todos" sea el default, que "Con deuda" achique la lista
  y que el total acompañe), y que un presupuesto impreso tenga los datos.
- **A ojo**: un presupuesto y un remito, mirando el PDF.

## 7. Qué cambió respecto de la v1

| v1 | Realidad | v2 |
| --- | --- | --- |
| `razon_social`/`cuit` como columnas de `sucursales` | Son dos contribuyentes; el modelo no depende del certificado | Tabla `emisores` + `sucursales.emisor_id` |
| Factura: `fiscal_config` gana, si no la sucursal | Una factura con CAE se reimprime del snapshot, que ya existe | Con CAE, sólo snapshot |
| "El celular sale siempre de la sucursal" | Podía mezclar la razón social de A con el teléfono de B | Cada sucursal pertenece a un emisor: no puede pasar |
| Filtro "Con deuda" por defecto | Cambia el significado de la pantalla | Default "Todos" |
| Umbral 0,01 "igual que el resto de la pantalla" | Falso: $0,01 se muestra y no entra en ningún filtro | Umbral 0 sobre el saldo redondeado |
| "Editables desde Sucursales" | Esa pantalla no existe y la tabla es de sólo lectura | Sección en `/facturacion` + server function admin |
| Remito: "ídem presupuesto" | El remito tiene origen Y destino | El emisor es el origen, explícito |
| No mencionaba el alto del encabezado | 40 mm fijos; el logo lo puede desbordar | Se mide |
