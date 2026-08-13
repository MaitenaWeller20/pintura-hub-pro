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

## 4. Accesibilidad: 146 labels sin asociar a su input

Los `<Label>` de los formularios no tienen `htmlFor` y los `<Input>` no tienen
`id` (sólo 3 de 149 están bien, en `/auth`). Un lector de pantalla no anuncia el
nombre del campo y hacer clic en la etiqueta no enfoca el input.

No lo pidió nadie y no rompe el uso con mouse, por eso no se hizo: son 146 sitios
y el riesgo de romper formularios que hoy andan es mayor que el beneficio
inmediato. Cuando haya margen, con un componente `<Campo label=…>` que genere el
id con `useId()`. Mientras tanto las pruebas usan el helper `campo()` de
`e2e/apoyo.ts` en vez de `getByLabel`.

## 5. `bun run lint` da falso verde

Hay tantos errores preexistentes que el formatter de ESLint revienta con
`RangeError: Invalid string length` **y sale con código 0**. O sea que "pasa"
sin haber revisado nada. No sirve para un CI hasta limpiarlo.

Mientras tanto, para revisar archivos puntuales: `npx eslint <archivos>`.

## 6. CUIL vs CUIT en la facturación

`docTipoAfip` etiqueta todo identificador de 11 dígitos como CUIT (tipo 80),
aunque el PDF ya conoce el tipo 86 = CUIL (`comprobante-pdf.ts:128`). No se puede
inferir por longitud ni por prefijo: haría falta guardar el tipo de documento en
la ficha del cliente. Es preexistente y es una decisión de negocio.

Relacionado: `docNroAfip` hace `Number(...)`, que se come los ceros a la
izquierda de un DNI.

## 7. Reimpresión de comprobantes viejos

Las facturas emitidas antes del 11/08 a clientes cargados a mano tienen el CUIT
congelado en dígitos; al reimprimirlas ahora salen con guiones, donde el papel
original salió sin. El dato declarado a AFIP (DocNro, CAE, totales) no cambia:
es sólo cómo se renderiza. Se aceptó a cambio de que todas las pantallas muestren
el documento igual.

## 8. Rotar los secretos expuestos

Contraseñas de usuarios reales quedaron escritas en el historial de chat, y hay
claves de Supabase expuestas de antes. Pendiente de seguridad, no de producto.
