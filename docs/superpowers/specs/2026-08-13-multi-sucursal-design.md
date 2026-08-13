# Un empleado que trabaja en más de una sucursal

Fecha: 2026-08-13
Estado: revisado por Codex (ronda 1) — listo para implementar

## El problema

Hay que dar de alta a Mauro, que trabaja en O'Higgins **y** en General Paz. Hoy
el sistema no lo permite: cada empleado está atado a una sola sucursal.

- `profiles.sucursal_id` es un único uuid y `current_sucursal_id()` lo devuelve.
- `crear_venta` corta con *"No podés facturar en una sucursal que no es la tuya"*.
- La RLS de `remitos` (INSERT) exige lo mismo para el origen.
- El selector de sucursal en la venta sólo se le muestra al admin (`ventas.nueva.tsx:571`).

Descartadas: dejarlo en una sola (en la otra no trabaja) y hacerlo admin (le
daría habilitar cuenta corriente, borrar clientes, anular ventas y administrar
usuarios).

## Superficie, medida contra producción

- **28 policies de RLS en 17 tablas** dependen de `current_sucursal_id()`.
- `crear_venta` y otras RPC la usan para autorizar.

Reescribir eso para que acepte una lista es mucha superficie de seguridad para
equivocarse, y además haría que los `SELECT` devuelvan las dos sucursales
mezcladas salvo que cada pantalla filtre a mano.

## El diseño: la sucursal ACTIVA

`profiles.sucursal_id` pasa a significar **"en cuál está trabajando ahora"**, y
en qué sucursales *puede* trabajar se guarda aparte.

`current_sucursal_id()` **no cambia**. Las 28 policies, `crear_venta` y el resto
siguen igual. Lo único que cambia es quién puede mover esa columna y a qué
valores. Y coincide con la realidad: está parado en un mostrador a la vez.

### 1. Una tabla, no un array

```sql
CREATE TABLE public.profile_sucursales (
  profile_id  uuid REFERENCES public.profiles(id)  ON DELETE CASCADE,
  sucursal_id uuid REFERENCES public.sucursales(id) ON DELETE RESTRICT,
  PRIMARY KEY (profile_id, sucursal_id)
);
```

Se evaluó `uuid[]` en `profiles` y se descartó: sin integridad referencial (borrar
una sucursal deja ids colgados), sin unicidad, admite NULL adentro, hay que
`unnest` para preguntar quién trabaja en tal sucursal, y un CHECK no puede
consultar `sucursales` para validar que exista.

Backfill: una fila por cada perfil que hoy tenga sucursal. Así nadie cambia de
comportamiento el día que se aplica.

### 2. La barrera es el TRIGGER, no la RPC

Esto es lo más importante del rediseño. `profiles` tiene `GRANT UPDATE` para el
propio usuario, así que **cualquiera puede hacer un PATCH directo por la API sin
pasar por ninguna RPC**. Toda regla que viva sólo en la RPC es decoración.

`guard_profiles_columnas` (versión vigente en
`20260803180000_permisos_por_seccion.sql:97`) pasa a permitirle a un no-admin
cambiar **sólo** su `sucursal_id`, y sólo a una en la que esté habilitado. El
resto de las columnas sigue bloqueado como hoy.

Con NULL hay que ser explícito, porque en SQL `NULL` no es `false`:

- `NEW.sucursal_id IS NULL` para un no-admin → se rechaza. Sin esto, un empleado
  se dejaría sin sucursal activa y pasaría inadvertido.
- La pertenencia se pregunta con `EXISTS`, no con `NOT (x = ANY(...))`, que con
  NULL no entra en el `IF`.

`sucursales_habilitadas` (la tabla) se protege con su propia RLS: sólo admin
escribe. Si no, cualquiera se auto-habilitaría todas las sucursales.

También hay que **impedir borrar la habilitación que está activa**, o el perfil
queda apuntando a una sucursal donde ya no puede trabajar.

### 3. Sin regla de "caja abierta"

El spec original decía que no se podía cambiar de sucursal con la caja abierta.
**Se descarta.** La caja es POR SUCURSAL, compartida, y se abre sola con la
primera operación del día (`caja_sesion_actual`): queda abierta hasta que alguien
la cierra a la noche. Esa regla habría dejado a Mauro sin poder cambiarse en todo
el día, y encima por una caja que abrió otra persona.

No hace falta: una venta en la sucursal activa se ata a la caja de esa sucursal,
que es lo correcto.

### 4. Registro de los cambios

```sql
CREATE TABLE public.sucursal_activa_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  desde_sucursal_id uuid REFERENCES public.sucursales(id),
  hacia_sucursal_id uuid NOT NULL REFERENCES public.sucursales(id),
  cambiado_en timestamptz NOT NULL DEFAULT now()
);
```

En un sistema con caja y stock, "quién estaba dónde y desde cuándo" es la primera
pregunta cuando una venta aparece en el lugar equivocado. Lo escribe el mismo
trigger.

### 5. Nada de CHECK que rompa el alta

Un `CHECK (sucursal_id = ANY(...))` rompería `createUser`: el trigger de
`auth.users` crea el perfil **sin sucursal** y recién después el backend lo
actualiza (`usuarios.functions.ts:76` y `:92`). El invariante "la activa está
entre las habilitadas" lo impone el trigger, que sí puede distinguir el alta
administrativa (`auth.uid() IS NULL` o admin) de un empleado cambiándose solo.

### 6. La app

- **Selector en el menú lateral**, sólo para quien tenga más de una habilitada.
- **Recarga completa al cambiar** (`window.location.reload()`), no invalidación
  selectiva: las queryKeys de ventas, presupuestos, remitos y compras no incluyen
  la sucursal, así que sin recargar quedarían a la vista filas de la anterior. La
  RLS protege la próxima consulta, pero no borra lo que el navegador ya tiene.
- La sucursal activa tiene que verse siempre. Ya hay un badge en el encabezado
  para no-admin; con dos sucursales pasa a ser crítico.
- `usuarios.tsx` y el validador de `usuarios.functions.ts:17` pasan a aceptar una
  lista, no un solo id.

## Lo que este cambio implica, y hay que decirlo

**Mauro va a poder ver y operar el historial de las dos sucursales**, una a la
vez. Al cambiar la activa, las policies le muestran las ventas, la caja, las
cuentas corrientes, las rendiciones y los remitos de esa sucursal. No es
escalación —son sucursales donde trabaja— pero deja de existir el aislamiento de
"cada uno ve lo suyo y nada más". Si eso no es aceptable, el diseño correcto es
otro y hay que hablarlo.

**La sucursal activa es pegajosa.** Si cambia y se olvida, la próxima venta sale
de la otra sucursal: descuenta ese stock y toma esa numeración. Todo técnicamente
correcto, en el lugar equivocado. Por eso el badge visible y el registro.

**Los admin no cambian.** Ya eligen sucursal en cada venta y el servidor se lo
permite; las habilitaciones no los limitan.

## Pruebas

SQL, contra local:
- un empleado cambia su activa a una habilitada: **anda**;
- a una NO habilitada: **rechaza**;
- a NULL: **rechaza**;
- modificar su propia lista de habilitadas: **rechaza**;
- borrar la habilitación que está activa: **rechaza**;
- un admin hace todo eso: **anda**;
- el alta de usuario (perfil sin sucursal y después UPDATE): **no se rompe**;
- el cambio queda registrado en el log.

E2E: con un usuario de dos sucursales el selector aparece y cambia; con uno de
una sola no aparece. Y la suite completa, para que no se rompa lo que ya andaba.
