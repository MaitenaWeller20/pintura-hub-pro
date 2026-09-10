# La fórmula de precio final de la clienta, descifrada

**Fecha:** 2026-08-03
**Origen:** la fórmula del Excel que hoy usa Glau para poner el precio de venta.

---

## 1. La fórmula tal como está

```excel
=SI(R15="";"";SI(N15<=$Y$6;(P15*(1-0,2613)*(1-0,04)*(1+$Z$6)*1,21);
 SI(N15<=$Y$2;(P15*(1-0,2613)*(1-0,04)*(1+$Z$2)*1,21);
 SI(N15<=$Y$3; … ) … )))))))))))))))))))))
```

21 `SI()` anidados. Todos hacen **exactamente lo mismo**; lo único que cambia es
qué celda de margen usan (`$Z$6`, `$Z$2`, `$Z$3`, …, `$AC$2`…, `$AF$8`).

## 2. Qué calcula, en una línea

Sacando el andamiaje, cada rama es:

```
precio_final_con_IVA = precio_lista × (1 − 0,2613) × (1 − 0,04) × (1 + margen) × 1,21
```

O sea, cuatro cosas encadenadas:

| Paso | Factor | Qué es |
|---|---|---|
| Bonificación del proveedor | `× 0,7387` | descuento del 26,13% sobre la lista |
| Pronto pago (o segunda bonificación) | `× 0,96` | otro 4% |
| Margen del negocio | `× (1 + margen)` | **lo único que varía** |
| IVA | `× 1,21` | 21% |

### Los dos descuentos son uno solo

```
0,7387 × 0,96 = 0,709152
```

**El descuento real que le hacen a la clienta es 29,0848%**, no 26,13% ni 30%.
Ese es el número que hay que cargar en el sistema como descuento del proveedor.

### La constante completa

```
0,709152 × 1,21 = 0,858074

precio_final_con_IVA = precio_lista × 0,858074 × (1 + margen)
```

Con un margen del 32%, el precio final es **1,132658 veces** el precio de lista.

## 3. De dónde sale el margen (y qué falta para saberlo)

El margen NO es fijo: es una **escala por tramos**. La fórmula compara `N15`
contra una serie de topes y usa el margen que le corresponde:

| Bloque de celdas | Topes | Márgenes | Cuántos tramos |
|---|---|---|---|
| `Y2:Z9` | `$Y$2`…`$Y$9` | `$Z$2`…`$Z$9` | 8 |
| `AB2:AC5` | `$AB$2`…`$AB$5` | `$AC$2`…`$AC$5` | 4 |
| `AE2:AF8` | `$AE$2`…`$AE$8` | `$AF$2`…`$AF$8` | 7 |

**Esas celdas no están en lo que me pasaste.** La fórmula dice cómo se calcula,
pero los números concretos (los topes y los márgenes de cada tramo) viven en esa
tablita al costado de la planilla. Para reproducirlo exacto en el sistema hace
falta una foto de `Y2:Z9`, `AB2:AC5` y `AE2:AF8`, y saber qué hay en la columna
`N` (¿el costo? ¿el precio de lista? ¿los litros?).

### Por qué esto explica la diferencia de $100 o $200

Sobre un producto de $118.344 de precio de lista:

| Margen | Precio final |
|---|---|
| 32,0% | $134.043,23 |
| 32,1% | $134.144,78 |

**Diferencia: $101,55.** O sea: "no es el 32%, es el 32 y algo" es literalmente la
explicación completa. Una décima de punto de margen son ~$100 en un producto de
ese precio. No hay ningún otro error escondido — sólo hace falta el número exacto
del tramo.

## 4. Tres problemas de la fórmula actual

### 4.1 El orden de los `SI` está mal y puede estar matando tramos

Los tests van en este orden: `$Y$6`, `$Y$2`, `$Y$3`, `$Y$4`, `$Y$5`, `$Y$7`, `$Y$8`, `$Y$9`, …

Una escalera de `SI` anidados **sólo funciona si los topes están en orden
creciente**, porque gana el primero que da verdadero. Si `$Y$2` fuera menor que
`$Y$6`, todo lo que debería caer en el tramo 2 ya habría entrado por el tramo 6,
y **`$Z$2` nunca se usaría**. Silencioso: no da error, da un precio equivocado.

Que `$Y$6` esté probado primero sugiere que alguien agregó un tramo nuevo más
barato y lo enchufó adelante. Si `$Y$6` es efectivamente el tope más chico, hoy
está bien **de casualidad**, y el próximo tramo que se agregue lo rompe.

### 4.2 Los mismos números están escritos 21 veces

`0,2613`, `0,04` y `1,21` aparecen una vez por rama: **63 constantes repetidas**.
Si el proveedor cambia la bonificación, hay que editar 21 lugares sin equivocarse
en ninguno.

### 4.3 El `1,21` está clavado

Cualquier producto con IVA del 10,5% sale mal. Hoy quizás no haya ninguno, pero
es una bomba de tiempo.

## 5. Cómo debería verse

**Paso 1 — una tabla de escalas, ordenada, en un lugar visible.** Por ejemplo en
`AH:AI`, ordenada de menor a mayor por la columna "Desde":

| | AH (Desde) | AI (Margen) |
|---|---|---|
| 2 | 0 | 0,45 |
| 3 | 1.000,01 | 0,40 |
| 4 | 5.000,01 | 0,35 |
| 5 | 20.000,01 | 0,321 |
| … | … | … |

Un tramo por fila. Se lee de un vistazo, se cambia sin tocar ninguna fórmula, y
se puede imprimir para discutirla con la clienta.

**Paso 2 — tres celdas con nombre** para las constantes (Fórmulas → Administrador
de nombres):

| Nombre | Celda | Valor |
|---|---|---|
| `Bonificacion` | `$C$1` | 0,2613 |
| `ProntoPago` | `$C$2` | 0,04 |
| `Iva` | `$C$3` | 0,21 |
| `Escalas` | `$AH$2:$AI$25` | (la tabla) |

**Paso 3 — la fórmula, entera:**

```excel
=SI(R15="";"";
   P15*(1-Bonificacion)*(1-ProntoPago)*(1+BUSCARV(N15;Escalas;2;VERDADERO))*(1+Iva))
```

Una línea. `BUSCARV(...;VERDADERO)` con la tabla ordenada devuelve el margen del
último tramo cuyo "Desde" es menor o igual a `N15` — que es exactamente lo que
hacen los 21 `SI`, pero sin que el orden pueda romperse.

Si querés que avise cuando un producto queda fuera de las escalas:

```excel
=SI(R15="";"";
   SI.ERROR(
     P15*(1-Bonificacion)*(1-ProntoPago)*(1+BUSCARV(N15;Escalas;2;VERDADERO))*(1+Iva);
     "revisar escala"))
```

**Paso 4 (opcional pero recomendado) — una columna que muestre qué margen aplicó:**

```excel
=SI(R15="";"";BUSCARV(N15;Escalas;2;VERDADERO))
```

Con eso, cuando un precio parezca raro, se ve en el acto si el problema es el
tramo o el precio de lista.

## 6. Qué relación tiene con lo que calcula el sistema hoy

La buena noticia: **es la misma cuenta**. `src/lib/precios.ts`, rama por costo:

```
costo        = precio_lista × (1 − descuento%)
precio_venta = costo × (1 + markup%)
con IVA      = precio_venta × (1 + iva%)
```

Contra el Excel:

```
costo        = precio_lista × 0,709152          ← descuento 29,0848%
precio_final = costo × (1 + margen) × 1,21      ← markup = margen
```

Idénticas. Las diferencias son sólo de **configuración**, y son tres:

1. **El descuento.** Hay que poner **29,0848%** en el proveedor
   (`proveedores.descuento_porcentaje`). El default del sistema es 0% (sin
   descuento); el 42% de Quimex vive en la ficha de ese proveedor.
2. **El markup por tramos.** El sistema tiene **un markup por producto** (o uno
   global), no una escala. Dos caminos posibles:
   - **(a)** con la tabla de escalas a la vista, cargar el markup que le toca a
     cada producto con la operación masiva de precios que ya existe (se filtra
     por rango y se aplica el markup del tramo). Sin código nuevo.
   - **(b)** agregar "markup por escala" como configuración del sistema, y que
     `calcularPrecios` lo resuelva solo. Es una feature nueva, con su espejo en
     la RPC `cambiar_precios_masivo`.
3. **⚠️ El precio sugerido al público.** Desde el 29/07 el sistema, si la lista
   trae la columna *"Sugerido al público c/IVA"*, calcula la venta **desde el
   sugerido**, no desde el costo:

   ```
   precio_venta = sugerido × (1 + markup) ÷ (1 + iva)
   ```

   El Excel de la clienta **no usa el sugerido para nada**. Son dos bases
   distintas, y esa diferencia es mucho más grande que $200: puede dar cualquier
   cosa. Antes de perseguir décimas de margen hay que decidir cuál de las dos
   quiere la clienta. Es una decisión de negocio, no un bug.

## 7. Lo que hace falta para cerrarlo

1. Foto o copia de `Y2:Z9`, `AB2:AC5` y `AE2:AF8` (los topes y los márgenes).
2. Qué contiene la columna `N` (contra qué se compara el tramo).
3. Definir si el precio de venta sale del **sugerido al público** o del **costo**
   (punto 6.3). De eso depende que los números coincidan o no.
