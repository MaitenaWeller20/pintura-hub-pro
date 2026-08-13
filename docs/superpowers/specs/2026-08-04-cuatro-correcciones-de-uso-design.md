# Cuatro correcciones salidas del uso real — 04/08/2026

Leo probó el sistema con la clienta y mandó cuatro fotos. Dos son cosas que el
sistema **hace pero esconde**, y dos son cosas que **no sabe hacer**. Conviene no
mezclarlas: las primeras se arreglan mostrando, las segundas hay que construirlas.

| # | Lo que reportó | Lo que realmente pasa |
|---|---|---|
| 1 | "No me deja crear nuevos usuarios" | El botón está deshabilitado porque la contraseña tiene 4 caracteres y el mínimo es 10. **Nada en pantalla lo dice.** |
| 2 | "Lo del stock todavía no me deja importar el archivo" | El botón existe, pero vive adentro del modo conteo, y entrar al conteo exige elegir sucursal primero. Estaba en "Todas las sucursales". |
| 3 | "Poder editar el % de descuento (no todos es el 42%)" | El descuento sale del proveedor o del global. **No hay descuento por producto**, y en el diálogo es un cartel fijo. |
| 4 | "No me deja editar los presupuestos" | Cierto: existen ver, imprimir, anular y convertir. Editar no existe. |

---

## 1. Usuarios: el botón mudo

`usuarios.tsx:152`

```
disabled={!form.email || !form.username || form.password.length < 10 || m.isPending}
```

Tres condiciones distintas, ninguna explicada. Es el mismo error que ya se
corrigió en compras: un botón que no se aprieta y no dice por qué obliga a
adivinar, y adivinar mal cuesta un mensaje de WhatsApp.

**Se replica el patrón de `faltanteCompra`**: una función pura que devuelve **el
único motivo** por el que no se puede guardar, en el orden en que se llenan los
campos. Va a `src/lib/alta-usuario.ts` con tests.

Y el diálogo de alta se pone a la altura del de reset, que ya está bien resuelto:
botón de generar contraseña fuerte y la leyenda del mínimo. Hoy el de alta no
tiene ninguno de los dos, que es exactamente por qué alguien escribe "aaaa".

Fuera de alcance: bajar el mínimo de 10. Es una decisión de seguridad ya tomada.

## 2. Stock: la importación escondida

Para importar hay que: elegir sucursal → "Conteo físico" → "Importar desde
archivo". Tres pasos, y el primero sólo se descubre fallando (un toast que se va
solo). Desde `/stock` no hay ninguna señal de que importar sea posible.

**Cambio**: un botón `Importar conteo` en el header, al lado de `Conteo físico`,
que abre el conteo y el diálogo de importación de una. El botón de adentro se
queda: quien ya está contando también quiere volcar un archivo.

El requisito de sucursal no se elimina —contar "todas" a la vez no significa
nada— pero deja de ser una sorpresa: el mensaje pasa a nombrar la importación, y
los botones se deshabilitan con el motivo en el `title` cuando el filtro está en
"Todas". Deshabilitado **con** motivo, no mudo.

## 3. Descuento por producto

Hoy la escalera es `proveedor ?? settings ?? 42`. La clienta dice que no todos
los productos llevan 42%, así que falta el escalón más específico.

**Se agrega `productos.descuento_porcentaje numeric(5,2)`, NULL = hereda.** Es
exactamente la forma que ya tiene `markup_porcentaje`, así que no inventa un
concepto: el producto puede tener el suyo, y si no, cae al del proveedor.

Escalera nueva: **`producto ?? proveedor ?? settings ?? 42`**.

Preguntar por `null`, NO por falsy: **0 es un descuento válido** (comprar a precio
de lista). Es el mismo bug que en su momento convirtió un markup de 0% en 30%.

Tres lugares tienen que aprender el escalón nuevo, y los tres tienen que dar el
mismo número:

1. `descuentoEfectivo()` en `precios.ts` — pasa a recibir el producto primero.
2. `cambiar_precios_masivo` en SQL — el `COALESCE` de la línea del descuento.
3. La importación de listas, que deriva el costo al ingerir.

Que 1 y 2 puedan divergir es el riesgo real (ya pasó con el redondeo), así que el
test compara uno contra otro.

**UI**: donde hoy dice `(lista − 42%)` va un campo `% Descuento` editable, con el
valor heredado como placeholder. Cambiarlo recalcula el costo desde la lista.
El costo sigue siendo editable a mano, como hasta ahora.

## 4. Editar presupuestos

RPC nueva `editar_presupuesto`, espejo de `crear_presupuesto`. Guardas: sólo
estado `ABIERTO` (un `CONVERTIDO` ya es una venta; un `ANULADO` está muerto),
misma sucursal, `FOR UPDATE`. Conserva `numero`, `fecha` y `usuario_id`: es el
mismo documento, no uno nuevo.

### La decisión que importa: qué pasa con los precios

`crear_presupuesto` deriva los precios del catálogo. Si `editar` hiciera lo
mismo, **cambiar una cantidad repreciaría todo el presupuesto** con la lista de
hoy. Alguien corrige un "3" por un "5" y sin querer le manda al cliente otros
precios en las otras seis líneas.

Eso además contradice a la tabla, que dice de sí misma:

> Snapshot: el presupuesto tiene que poder reimprimirse igual dentro de un mes.

**Por defecto se conserva el precio guardado** de las líneas que ya estaban;
sólo las líneas **nuevas** toman el precio de hoy. Repreciar es una acción
explícita: `p_repreciar boolean DEFAULT false`, y en pantalla un cartel que
aparece únicamente si algún precio se movió — "3 productos cambiaron de precio
desde que se hizo este presupuesto" con el botón para actualizarlos.

El cliente **no manda precios**: manda `producto_id`, `cantidad` y `descuento`.
El precio lo decide el servidor —del snapshot o del catálogo— igual que hoy. Si
el precio viajara en el request, cualquiera podría presupuestar a cero.

### El producto archivado

`crear_presupuesto` rechaza productos inactivos o archivados. Aplicado tal cual a
la edición, un presupuesto con un producto discontinuado **no se podría editar
nunca más** — ni siquiera para sacar esa línea, que es justo lo que haría falta.

Regla: un producto que **ya estaba** en el presupuesto se acepta aunque esté
archivado (ya está en el papel, ya se lo prometieron al cliente). Uno que se
**agrega ahora** se valida como siempre.

### Pantalla

Ruta `/presupuestos/$id/editar`, con la forma de `/presupuestos/nuevo`, y un
botón `Editar` en el detalle que aparece sólo si el estado es `ABIERTO`.

---

## Lo que encontró la revisión adversarial

Siete verificaciones contra la base y el código antes de escribir nada. Tres
cambiaron el diseño:

1. **`crearUsuario` validaba `min(6)` en el servidor y la pantalla exigía 10.**
   El mínimo real dependía de por dónde entrara el pedido. Se unifica en 10, y
   la constante vive en un solo lugar.
2. **`convertir_presupuesto_en_venta` factura con `presupuesto_items.precio_sin_iva`**,
   no con el catálogo (verificado en la definición vigente). Así que repreciar al
   editar no sería cosmético: cambiaría lo que se le cobra al cliente. Confirma
   que conservar el precio tiene que ser el default y no una opción.
3. **La importación de listas ya tenía su propia escalera**, y guardaba el
   descuento *del proveedor* en un campo llamado `descuento_porcentaje`. Hay que
   partirlo en dos (`descuento_porcentaje` del producto y
   `descuento_proveedor_porcentaje` del proveedor) o elegir un proveedor para el
   archivo pisaría el override del producto.

Y cuatro que confirmaron que el diseño se podía hacer como estaba:

4. `convertir` y `anular` ya toman `SELECT ... FOR UPDATE` sobre la fila del
   presupuesto, así que `editar` con el mismo lock queda serializado contra los
   dos. No hace falta nada más.
5. `trg_presupuestos_upd` ya mantiene `updated_at`, y **ninguna FK apunta a
   `presupuesto_items`**: borrar y reinsertar las líneas es seguro.
6. `productos` no tiene guard de columnas ni GRANT por columna, y `FORCE ROW
   LEVEL SECURITY` está en `false` en las tres tablas: la columna nueva no
   necesita permisos aparte.
7. Un mismo `producto_id` dos veces en `p_items` haría ambiguo de cuál línea sale
   el precio guardado. La pantalla ya lo impide; la RPC lo rechaza explícito.

## Qué se prueba

- `alta-usuario.test.ts` — el motivo que devuelve, en orden, y que no haya
  estados donde el botón esté deshabilitado sin motivo.
- `precios.test.ts` — la escalera de 4 escalones, el 0 que no cae al global.
- SQL — la escalera de `cambiar_precios_masivo` contra la de TypeScript.
- SQL — editar conserva número y precios; repreciar los mueve; convertido y
  anulado rechazan; el producto archivado que ya estaba se acepta y el nuevo no.
