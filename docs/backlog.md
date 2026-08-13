# Backlog

Lo que quedó pendiente, en orden de lo que más molesta. Cada punto dice qué es,
por qué importa y dónde tocar.

---

## 1. No se pueden cambiar las sucursales de un usuario que ya existe

**Qué falta.** Los checkboxes de "Sucursales donde trabaja" están sólo en el alta
(`usuarios.tsx`, diálogo "Nuevo usuario"). Para un usuario que ya existe no hay
ningún botón: la fila sólo ofrece Permisos, Contraseña y Activar/Desactivar.

**Por qué importa.** El día que haya que habilitar a Renzo en O'Higgins, o sacarle
una sucursal a Mauro, el único camino es SQL a mano contra producción — sin las
validaciones que sí tiene el alta y con el riesgo que eso trae.

**Cómo.** Un botón "Sucursales" en cada fila que abra un diálogo con los mismos
checkboxes, respaldado por una server function admin que haga insert/delete en
`profile_sucursales`. Ojo: borrar la habilitación ACTIVA falla por el trigger
`guard_sacar_sucursal_habilitada` — hay que cambiarle la activa primero o no
ofrecer destildarla.

**Y de paso**, cerrar la carrera que marcó el review: el DELETE debería tomar el
lock de la fila de `profiles` (`SELECT ... FOR UPDATE`) antes de chequear si esa
sucursal está activa. Hoy no es alcanzable porque no hay UI que dispare el DELETE.

## 2. Evitar que se venda en la sucursal equivocada

**Qué falta.** La sucursal activa es pegajosa: si alguien la cambia y se olvida, la
próxima venta descuenta el stock de la otra sucursal y toma su numeración. Las
sesiones no se cierran solas (`persistSession: true`), así que la sucursal de ayer
se arrastra a hoy.

**Decidido con Leo:**

- Si la activa se eligió **otro día**, al entrar pedirle que confirme dónde está
  hoy (una sola vez, no molesta más). `sucursal_activa_log` ya guarda cuándo fue.
- La **primera venta después de cambiar** de sucursal pide confirmación explícita.
- Sólo para quien tenga más de una habilitada: los demás no ven nada nuevo.

Se descartó pedir confirmación en todas las ventas: con cola en el mostrador se
vuelve un enter automático que nadie lee.

## 3. Que las pantallas anden bien en el celular

Pedido de Leo. Hoy la suite E2E prueba sólo a 1366×768 (la máquina de la
sucursal), así que nada garantiza que en un celular o una tablet se vea bien.

A revisar en 375px y ~768px: las tablas anchas (ventas, productos, stock,
cuentas corrientes), el menú lateral, los formularios de dos columnas y los
diálogos. Y agregar un proyecto de Playwright con viewport móvil para que quede
cubierto.

## 4. Emitir a AFIP una nota sin factura puntual (período asociado)

**Qué falta.** Hoy una nota de crédito sin comprobante asociado se puede guardar,
pero queda como documento **interno**: no se manda a AFIP. Es lo que hace falta
para la devolución cuya factura salió del sistema viejo, pero no rectifica nada
ante AFIP.

**Lo que dice la norma.** Según la **RG 4540/2019**, una NC/ND electrónica tiene
que informar **o** el/los comprobante(s) asociado(s) (`CbtesAsoc`) **o** el
período asociado (`PeriodoAsoc`, desde/hasta) — uno u otro, no los dos. O sea que
la nota sin factura puntual **sí se puede emitir legalmente**, informando el
período. Ese es el camino correcto para rectificar una factura de 3C.

**Por qué no se hizo.** `arca.ts` no tiene el modelo: `DatosCae` sólo acepta
`comprobantesAsociados` (`arca.ts:35-48`) y sólo serializa `CbtesAsoc`
(`arca.ts:246-252`). Y la facturación está en `MOCK` porque el certificado no
salió, así que un cambio de payload no se puede validar contra homologación.
Mandar a producción un payload fiscal que nunca vio homologación es peor que no
mandarlo.

**Cuándo.** Cuando esté el certificado. Ahí también hay que revisar la nota de
DÉBITO sin factura, que hoy se rechaza: una ND por intereses de un período es
fiscalmente válida, pero la pantalla calcula el recargo como porcentaje del total
de una factura concreta y habría que rediseñarla.

## 5. Notas sin mercadería (bonificaciones, ajustes de saldo)

**Qué falta.** El sistema no puede expresar una nota de crédito que no mueva
stock: `crear_venta` exige al menos un ítem con cantidad > 0 y repone stock por
cada ítem de una `NOTA_CREDITO`. Una bonificación comercial o un ajuste de saldo
cargados como nota inflarían el inventario.

**Por qué importa.** Un descuento de fin de mes o el arreglo de un saldo viejo hoy
no tienen forma de cargarse. Se descubrió revisando la nota sin factura y no se
resolvió ahí porque es otro pedido: necesita decidir si la nota lleva una línea de
concepto libre (como ya hace la nota de débito con el recargo) y si eso debería
tocar stock o no.

## 6. La regla de "la nota al contado devuelve algo", también para `anular_venta`

`crear_venta` ya rechaza una nota de crédito al contado sin ningún pago: no le
devolvía la plata al cliente ni le acreditaba saldo, y la operación no quedaba en
ningún lado. Las notas que genera `anular_venta` no pasan por ahí (se insertan
directo) y hoy resuelven la plata de otra manera —anulando la deuda original o
copiando los pagos negados—, así que no están rotas. Pero el criterio quedó en dos
lugares distintos. Vale unificarlo cuando se toque esa función.

## 7. Navegar apenas se entra puede tirar un error de router

**Qué pasa.** Si se cambia de pantalla mientras el layout autenticado todavía se
está hidratando, TanStack tira `Invariant failed: Could not find match for matchId
"/_authenticated/"` y React avisa que tuvo que recuperarse hidratando del lado del
cliente. La app **se recupera sola** y el usuario no ve nada roto, pero ensucia la
consola y es la clase de carrera que un día se cae mal.

**Cómo se encontró.** La suite E2E fallaba de a ratos en una pantalla distinta cada
corrida y pasaba siempre al correr esa prueba sola: la firma de una carrera que se
abre cuando el server está cargado. El helper `ingresar()` de `e2e/apoyo.ts` ahora
espera a que la app asiente antes de devolver el control, así que la suite quedó
estable, pero eso tapa el síntoma en las pruebas, no lo arregla en la app.

**Por qué no se arregló acá.** No es alcanzable a mano fácilmente (hay que entrar y
clickear en el mismo instante, con la máquina cargada), se recupera solo, y tocar el
arranque del router es justo donde ya se rompieron dos intentos de arreglar la
hidratación. Cuando se toque, reproducirlo primero con el CPU throttleado.

## 8. Accesibilidad: 146 labels sin asociar a su input

Los `<Label>` de los formularios no tienen `htmlFor` y los `<Input>` no tienen
`id` (sólo 3 de 149 están bien, en `/auth`). Un lector de pantalla no anuncia el
nombre del campo y hacer clic en la etiqueta no enfoca el input.

No lo pidió nadie y no rompe el uso con mouse, por eso no se hizo: son 146 sitios
y el riesgo de romper formularios que hoy andan es mayor que el beneficio
inmediato. Cuando haya margen, con un componente `<Campo label=…>` que genere el
id con `useId()`. Mientras tanto las pruebas usan el helper `campo()` de
`e2e/apoyo.ts` en vez de `getByLabel`.

## 9. `bun run lint` da falso verde

Hay tantos errores preexistentes que el formatter de ESLint revienta con
`RangeError: Invalid string length` **y sale con código 0**. O sea que "pasa"
sin haber revisado nada. No sirve para un CI hasta limpiarlo.

Mientras tanto, para revisar archivos puntuales: `npx eslint <archivos>`.

## 10. CUIL vs CUIT en la facturación

`docTipoAfip` etiqueta todo identificador de 11 dígitos como CUIT (tipo 80),
aunque el PDF ya conoce el tipo 86 = CUIL (`comprobante-pdf.ts:128`). No se puede
inferir por longitud ni por prefijo: haría falta guardar el tipo de documento en
la ficha del cliente. Es preexistente y es una decisión de negocio.

Relacionado: `docNroAfip` hace `Number(...)`, que se come los ceros a la
izquierda de un DNI.

## 11. Reimpresión de comprobantes viejos

Las facturas emitidas antes del 11/08 a clientes cargados a mano tienen el CUIT
congelado en dígitos; al reimprimirlas ahora salen con guiones, donde el papel
original salió sin. El dato declarado a AFIP (DocNro, CAE, totales) no cambia:
es sólo cómo se renderiza. Se aceptó a cambio de que todas las pantallas muestren
el documento igual.

## 12. Rotar los secretos expuestos

Contraseñas de usuarios reales quedaron escritas en el historial de chat, y hay
claves de Supabase expuestas de antes. Pendiente de seguridad, no de producto.
