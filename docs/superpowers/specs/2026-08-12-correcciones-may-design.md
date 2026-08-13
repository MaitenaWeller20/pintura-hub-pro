# Correcciones reportadas por May (12/08)

Fecha: 2026-08-12
Estado: spec para revisión de Codex, antes de implementar

Ocho pedidos que llegaron juntos por audio y fotos. Van en un solo spec porque dos
de ellos comparten causa raíz y conviene verlo junto.

---

## 1 y 2. "Se superpone toda la pantalla" y "no lo deja crear un remito a Renzo"

**Son el mismo bug.** No es un problema de permisos.

`src/components/ui/dialog.tsx:41` — el `DialogContent` base está centrado con
`translate-y-[-50%]` y **no tiene alto máximo ni overflow**:

```
fixed left-[50%] top-[50%] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] ...
```

Un diálogo más alto que la ventana se derrama por arriba **y** por abajo en partes
iguales, y como no hay scroll no se puede llegar al footer. El botón Guardar queda
literalmente fuera de la pantalla. `NuevoRemitoDialog` (`remitos.tsx:279`) es alto
—dos selects, buscador de productos y la grilla de ítems— así que es de los
primeros en pasarse. En una pantalla más baja que la de May (la de San Armento) se
pasa siempre: por eso a Renzo "no le deja" y a ella sí.

`src/components/ui/alert-dialog.tsx:37` tiene el mismo defecto, copiado.

**Arreglo:** en los dos componentes base, no en cada diálogo.
`max-h-[calc(100dvh-2rem)] overflow-y-auto`, más `w-[calc(100%-2rem)]` para que en
el celular no quede pegado a los bordes. `dvh` y no `vh` porque en el navegador del
celular la barra de direcciones se come parte del `vh` y el footer volvería a
quedar tapado.

Por qué en la base y no en los 14 diálogos que hoy no lo tienen: ya hay 8 que lo
resuelven a mano (`max-h-[88vh] overflow-y-auto` repetido). Parchear los 14
restantes garantiza olvidarse del próximo que se escriba. Con `tailwind-merge` los
8 que ya traen su propio `max-h` siguen ganando, así que no cambian.

**Riesgo a verificar:** que `overflow-y-auto` no recorte los `Popover`/`Select` que
viven adentro de un diálogo (el buscador de productos del remito). Radix los
renderiza en un portal, así que no deberían recortarse — hay que confirmarlo en
pantalla, no de memoria.

## 3. La compu de San Armento se ve "sin colores"

Foto oscura y sin estilos. Hipótesis a descartar en orden: (a) el CSS no cargó por
caché vieja, (b) modo de alto contraste de Windows, (c) zoom del navegador que
agrava el desborde del punto 1. Es probable que (c) sea todo el problema y se
resuelva solo con el arreglo de arriba. **No se toca nada hasta reproducirlo**;
si después del deploy sigue igual, se pide captura de pantalla real (no foto) y el
navegador/versión.

## 4. Presupuestos: hay productos que no aparecen

`presupuestos.nuevo.tsx:78`:

```js
.or(`codigo.ilike.%${busqueda}%,nombre.ilike.%${busqueda}%`)
.eq("activo", true).eq("archivado", false)
.limit(10)
```

**`.limit(10)` sin ningún `order`.** Si lo que escribe matchea más de 10 productos,
Postgres devuelve 10 cualesquiera y el que ella busca puede no estar. En Ventas no
pasa porque baja el catálogo completo paginado (`traerTodo`) y filtra en memoria.
Eso explica exactamente "en venta sí me sale y en presupuesto no".

**Arreglo:** igualar el comportamiento al de Ventas — mismo buscador, mismo
catálogo. De paso el `.or()` se arma con `filtroIlikeOr` (ya existe, del arreglo de
CUIT), porque hoy un producto con coma en el nombre rompe el filtro.

`remitos.tsx:255` tiene el mismo `.limit(10)` sin orden: mismo arreglo.

## 5. Presupuestos: precio con IVA, sin discriminar

Hoy (`presupuestos.$id.tsx:243-254`) la grilla muestra "Precio de lista" y "Precio"
**sin IVA**, y sólo el subtotal con IVA. May: *"la vendemos a 157 y en el
presupuesto figura 130 y abajo el IVA"*. Motivo de negocio: hay clientes a los que
no les quieren mostrar el desglose.

**Arreglo:** el unitario y el precio de lista se muestran **con IVA**, igual que el
subtotal, y desaparece la línea de IVA discriminado del total. Aplica a la pantalla
y al PDF.

**Cuidado:** esto es sólo presentación. Los valores guardados siguen siendo netos
(es lo correcto para pasar el presupuesto a venta y para AFIP). No se toca la
tabla ni la RPC.

## 6. Remito de obra sin elegir cliente

Hoy `Cliente *` es obligatorio (`ventas.nueva.tsx:506`, `ventas.functions.ts:48`
con `cliente_id: z.string().uuid()`, y la RPC valida que exista y esté activo).
May: *"las obras no las guardamos como clientes"*.

**No alcanza con sacar la validación.** `REMITO_OBRA` está en `TIPOS_CTA_CTE`, o
sea que **genera deuda en cuenta corriente**, y la cuenta corriente cuelga del
cliente (`cc_saldo(cliente_id)`). Sin cliente, esa deuda no tiene dueño: no se le
puede cobrar a nadie ni aparece en ningún saldo. En la foto de May son $183.510.

**Decisión tomada con Leo: cliente automático por obra.** Al guardar un remito de
obra, si no se eligió cliente, se busca/crea un cliente con el nombre de la obra y
la venta se le asigna. May escribe la obra y listo; cada obra tiene su cuenta
corriente y su saldo cobrable.

Detalles a definir en la implementación:
- La búsqueda del cliente de obra tiene que ser por nombre normalizado
  (`claveNombre`, que ya existe) para que "Obra Distrito" y "OBRA DISTRITO" no
  creen dos fichas.
- Se marcan de alguna forma para distinguirlos de los clientes de verdad (una
  columna `es_obra`, o el flag `es_generico` que ya existe). A definir.
- El cliente de obra nace con `condicion_cta_cte = true`, si no la venta a cuenta
  corriente la rechaza la propia RPC. **Ojo:** el trigger `guard_clientes_credito`
  impide que un EMPLEADO cree clientes con cuenta corriente. Si esto se hace desde
  el navegador, a un empleado le va a fallar. Por eso conviene resolverlo **dentro
  de la RPC `crear_venta`** (que es `SECURITY DEFINER`), no en el frontend.

## 7. Ingresos de mercadería: ver y corregir lo cargado

Un ingreso `CONFIRMADO` sólo ofrece "anular" (`ingresos-mercaderia.index.tsx:118`);
no hay forma de abrirlo para ver qué se cargó. May quiere controlar lo que ingresó.

**Arreglo:** vista de detalle de sólo lectura (proveedor, remito, fecha, ítems con
cantidades y costos, quién lo cargó).

Sobre "modificar cantidades": **no se edita un ingreso confirmado.** Ya movió
stock; editarlo en silencio descuadra el inventario contra lo que realmente entró.
El camino correcto es el que ya existe: anular y volver a cargar, que deja rastro.
Lo que sí se puede mejorar es que el detalle esté a mano para detectar el error.
Esto hay que confirmarlo con May antes de darlo por cerrado.

## 8. Usuario de Mauro

Alta de usuario. Falta el mail y qué secciones/sucursal le corresponden.
**No se usan las contraseñas que se pegaron en el chat**; se rotan aparte.

---

## Plan de pruebas

Leo: *"no puede ser que haya cosas que no anden"*. Tiene razón, y la causa es que
hoy no queda nada corriendo después de cada entrega: se prueba a mano una vez y
listo, así que una regresión en una pantalla que nadie tocó no la agarra nadie.

Se agrega una suite Playwright **en el repo**, que corra sola:

1. **Humo de todas las pantallas**: entrar a cada ruta autenticada y verificar que
   renderiza sin error de consola. Barato y agarra las pantallas rotas.
2. **Diálogos**: abrir cada diálogo con la ventana en 1366×768 (la de San Armento)
   y verificar que el botón de acción principal esté **dentro del viewport y
   clickeable**. Es la prueba que habría agarrado este bug.
3. **Flujos críticos**: venta contado, venta cta cte, remito interno, remito de
   obra, presupuesto, ingreso de mercadería, alta de cliente duplicado.
4. **ABMC** de clientes, proveedores y productos: alta, edición, baja y consulta.

Corre contra el entorno local con datos sembrados, no contra producción.
