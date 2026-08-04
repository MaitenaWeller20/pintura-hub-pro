# Permisos por sección: elegir qué pantallas ve cada usuario

**Fecha:** 2026-08-03
**Estado:** spec

---

## 1. El pedido

> "hace un usuario admin dame las credenciales y permitime crear usuarios y
> asignarles a estos usuarios qué cosas o secciones quieren que vean, porque hay
> ciertos permisos según el rol."

Dos cosas distintas:

1. Que exista un admin de verdad con credenciales propias (hoy se entra con
   "Usuario de Prueba").
2. Que un admin pueda decidir, **por usuario**, qué secciones del menú ve.

## 2. Cómo está hoy

`src/routes/_authenticated/route.tsx` tiene el menú hardcodeado con un booleano
por ítem:

```ts
type MenuItem = { to: string; label: string; icon: …; adminOnly: boolean };
…
const items = group.items.filter((i) => !i.adminOnly || cu.isAdmin);
```

O sea: hay exactamente **dos** configuraciones posibles de menú en todo el sistema
—la de admin y la de empleado— y para cambiarlas hay que tocar el código y
desplegar. No hay forma de que un empleado vea Ventas pero no Compras.

El único permiso granular que existe es `profiles.permite_venta_sin_stock`, con un
patrón ya probado: columna en `profiles`, trigger `guard_profiles_columnas` que
impide auto-otorgárselo, y server function con chequeo de `is_admin`. **Esta spec
copia ese patrón**, no inventa uno nuevo.

## 3. Alcance honesto: esto es visibilidad, no una frontera de seguridad

Hay que decirlo antes de diseñar nada, y hay que decirlo también **en la pantalla**.

Lo que de verdad protege los datos es RLS y los `is_admin()` adentro de las RPC.
Esconder "Reportes" del menú no impide que alguien con la sesión abierta consulte
PostgREST a mano. Un permiso por sección **ordena la aplicación** —que cada uno vea
lo suyo y no se equivoque de pantalla— y no reemplaza a lo otro.

Consecuencia de diseño: no se toca ninguna policy de RLS ni ninguna RPC. Si en
algún momento hace falta que "no ver Reportes" signifique "no poder leer los
totales", eso es otro trabajo, con RLS por sección, y hay que decidirlo aparte.

La pantalla de permisos va a llevar este texto:

> Esto ordena **qué pantallas ve cada uno**. Los permisos de fondo (quién puede
> borrar, quién puede vender sin stock, quién ve la plata) los sigue mandando el
> rol.

## 4. Diseño

### 4.1 El catálogo de secciones vive en un solo lugar

Se extrae `src/lib/secciones.ts`:

```ts
export type Seccion = {
  key: string;          // 'ventas'
  ruta: string;         // '/ventas'
  label: string;        // 'Ventas'
  grupo: string;        // 'Operación'
  /** No se puede otorgar: es el panel de control de los permisos. */
  soloAdmin?: boolean;
};
export const SECCIONES: Seccion[] = [ … ];
export const SECCIONES_DEFAULT: string[];   // lo que ve hoy un empleado
export function seccionDeRuta(path: string): Seccion | undefined;
export function puedeVer(seccion, cu): boolean;
```

`route.tsx` deja de tener la lista y pasa a mapear `key → icono`. La pantalla de
usuarios y el guard leen **la misma** lista. Una lista sola es lo que evita que el
menú y el guard se desincronicen (el permiso oculta el link pero la URL sigue
entrando, que es el bug clásico de esta feature).

Secciones: `dashboard, ventas, presupuestos, remitos, productos, stock, clientes,
compras, ingresos_mercaderia, proveedores, pagos_proveedores, gastos, pagos,
cuentas_corrientes, arqueo, reportes, facturacion, usuarios`.

`usuarios`, `reportes` y `facturacion` se marcan `soloAdmin` y **no son
otorgables**. La primera versión de esta spec hacía otorgables a las dos últimas
—"son adminOnly por costumbre, no por una regla de servidor"— y era falso: las
tres tienen un `beforeLoad` propio que rechaza a los no-admin, y facturación
además tiene server functions con `requireAdmin`. Ofrecerlas en la lista de
permisos prometería algo que el servidor no va a cumplir. Ver §8.1.

### 4.2 Dónde se guarda

```sql
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS secciones text[];
```

Semántica del `NULL`, que es la decisión importante:

| Valor | Significado |
|---|---|
| `NULL` | "las de siempre" → `SECCIONES_DEFAULT`. **Es el default y no cambia nada para nadie.** |
| `'{}'` | ninguna sección (usuario suspendido de hecho) |
| `'{ventas,pagos}'` | exactamente esas |

Se elige `NULL` = default en vez de rellenar todos los perfiles con la lista
completa porque, si mañana se agrega una sección nueva, los usuarios existentes la
ven sin que nadie tenga que reabrir 8 perfiles. Rellenar la columna en la migración
congelaría a cada usuario en el menú de hoy — es la clase de decisión que se paga
seis meses después.

Un admin ve todo siempre, tenga lo que tenga en la columna. No se puede quedar
afuera de su propio sistema.

### 4.3 Quién puede escribirla

`profiles` tiene `GRANT UPDATE … TO authenticated` y la policy
`user update own profile (id = auth.uid())`. Sin protección extra, **cualquier
empleado se auto-otorgaría todas las secciones con un PATCH**. La columna se suma
al guard existente:

```sql
IF NEW.secciones IS DISTINCT FROM OLD.secciones THEN
  RAISE EXCEPTION 'Sólo un administrador puede cambiar las secciones de un usuario';
END IF;
```

Igual que `permite_venta_sin_stock`. El guard ya exime a `auth.uid() IS NULL`
(service_role, el canal del backend) y a los admins.

La escritura desde la app va por una server function nueva,
`setSeccionesUsuario`, con el mismo molde que `setPermiteVentaSinStock`:
`is_admin` + `supabaseAdmin`. Valida que cada key exista en el catálogo y que
ninguna sea `soloAdmin` — si no, un `PATCH` con `secciones: ['../../etc']` guardaría
basura que después nadie sabe de dónde salió.

No hace falta impedir que un admin edite sus propias secciones: un admin ve todo
igual, así que no puede autobloquearse. (La primera versión de esta spec incluía
esa regla con esa justificación equivocada. Ver §8.5.)

### 4.4 Cómo se aplica

Tres lugares, todos en `_authenticated/route.tsx`:

1. **Menú**: `groups` se filtra por `puedeVer`.
2. **Ruta**: si la ruta actual cae en una sección no permitida, en vez del
   `<Outlet/>` se renderiza un panel "No tenés acceso a esta pantalla" con los
   links a lo que sí tiene. Un panel y no un `redirect` para no arriesgar loops de
   navegación con el guard de sesión que ya vive en `beforeLoad`.
3. **Aterrizaje**: si entra a `/` y no tiene `dashboard`, se navega a su primera
   sección permitida. Si no tiene **ninguna**, cartel explícito: "Tu usuario no
   tiene ninguna sección habilitada. Pedile a un administrador que te habilite
   alguna." — mejor eso que una app en blanco.

`useCurrentUser` suma `secciones` al `select` de `profiles` (una columna más en una
query que ya se hace; no agrega round-trips).

### 4.5 La pantalla

En `/usuarios`, un botón de llave por fila abre un diálogo:

```
┌─ Permisos de mrodriguez ─────────────────────────┐
│ Esto ordena qué pantallas ve. Los permisos de    │
│ fondo los sigue mandando el rol.                 │
│                                                  │
│ ( ) Las de siempre (según el rol)                │
│ (•) Elegir a mano                                │
│                                                  │
│   Operación      [x] Ventas   [x] Presupuestos   │
│                  [ ] Remitos                     │
│   Catálogo       [x] Productos [x] Stock  …      │
│   …                                              │
│                                                  │
│ [x] Puede vender sin stock                       │
└──────────────────────────────────────────────────┘
```

El radio "Las de siempre" es el que escribe `NULL`. `permite_venta_sin_stock` se
muda acá adentro: hoy es un ícono en la fila cuyo único indicio es el `title`, y
conceptualmente es un permiso, igual que los otros.

En admins los checkboxes se muestran deshabilitados con la leyenda "Un
administrador ve todas las secciones".

## 5. El usuario admin

No lo crea un script contra producción. Ya existe `/usuarios` (server function con
`service_role` del lado del servidor) y ya hay una sesión admin abierta: crear el
usuario desde ahí es el camino que la app ya soporta, y de paso es la prueba
Playwright de esta misma feature.

Lo que aporta esta spec: una contraseña fuerte generada, y el recordatorio de que
el usuario "de Prueba" se desactiva una vez que el admin nuevo entra — un admin
compartido y con nombre de prueba es exactamente el hábito que dejó quemadas las 5
contraseñas originales (ver memoria `rotar-secretos-quimex`).

## 6. Lo que NO entra

- **RLS por sección.** Explicado en §3.
- **Permisos por acción** ("puede ver Ventas pero no anular"). El único que existe
  hoy es `permite_venta_sin_stock` y se mantiene. Sumar más es otra spec.
- **Roles a medida** (crear un rol "Cajero" reutilizable). Con 5 usuarios, por
  usuario alcanza; roles nombrados son la evolución natural si crecen.

## 7. Plan de pruebas

**Unitarias** (`src/lib/secciones.test.ts`):
1. `SECCIONES_DEFAULT` es exactamente lo que ve hoy un empleado (protege la
   compatibilidad: si alguien agrega una sección al catálogo sin pensar, el test
   canta)
2. toda sección tiene una ruta que existe en el router
3. `seccionDeRuta` resuelve rutas hijas (`/compras/nueva` → `compras`)
4. `seccionDeRuta('/')` → `dashboard` y no matchea todo lo demás (el `startsWith`
   de `isActive` ya tiene ese caso especial)
5. admin ve todo, con `secciones` en `'{}'` incluido
6. `NULL` → default; `'{}'` → nada; lista → esa lista
7. una key desconocida guardada en la base se ignora sin romper

**SQL** (`scripts/test-permisos-seccion.sh`, base local):
8. un empleado NO puede hacer `PATCH profiles.secciones` sobre sí mismo → el guard
   lo rechaza
9. un empleado NO puede hacerlo sobre otro → RLS lo rechaza
10. un admin sí puede
11. `service_role` sí puede (canal del backend)

**Playwright**: crear un usuario con sólo Ventas y Stock, entrar con él, verificar
que el menú tiene esos dos + que `/compras` escrito a mano muestra el panel de sin
acceso.

## 8. Review de la spec (Codex)

Cinco hallazgos. Los dos importantes cambiaron el diseño:

1. **`reportes` y `facturacion` NO pueden ser otorgables.** Las dos rutas ya
   rechazan a los no-admin en su propio `beforeLoad`
   (`reportes.tsx:25`, `facturacion.tsx:39`), y facturación tiene server
   functions con `requireAdmin`. Ofrecerlas en la lista de permisos habría
   prometido algo que el servidor no cumple: el usuario rebotaría antes de ver la
   pantalla, o entraría a una donde todo falla. **Corregido**: las tres
   (`reportes`, `facturacion`, `usuarios`) quedan `soloAdmin`, no otorgables.
2. **Contradicción con el contrato.** La spec prometía "quién ve la plata lo
   sigue mandando el rol" y al mismo tiempo hacía otorgable Reportes. Se resuelve
   con lo anterior.
3. **`seccionDeRuta` necesita match por ruta más larga**: `/pagos` y
   `/pagos-proveedores` se solapan. **Corregido** y con test propio: se ordena de
   ruta más larga a más corta y se exige que el corte caiga en un separador.
4. **Rutas con `beforeLoad` propio esquivan el panel de "sin acceso".** Cierto, y
   deja de importar con la corrección 1: las únicas tres que tienen `beforeLoad`
   de admin son justo las no otorgables.
5. **"No se puede editar las propias secciones" estaba mal justificado.** Un admin
   ve todo igual, así que no puede autobloquearse. **Regla eliminada** de la spec.

Señalado como sobre-diseño: meter `permite_venta_sin_stock` en el mismo diálogo
mezcla visibilidad con un permiso autoritativo. Se mantuvo en el mismo diálogo
(es donde alguien lo va a buscar) pero **en un bloque aparte y con el texto que
explica la diferencia**: "Éste no es de pantallas: cambia lo que el sistema lo
deja hacer".

## 9. Review del código (Codex)

_Ver §10._

## 10. Verificación

**Unitarias** — 24 tests en `secciones.test.ts` (232 en total, `tsc` limpio).
Incluye el contrato de compatibilidad: `SECCIONES_DEFAULT` se compara contra la
lista literal del menú de hoy, así que agregar una sección sin decidir si un
empleado la ve rompe el test antes de producción.

**SQL** — `scripts/test-permisos-seccion.sh`, 17 verdes:
- el CHECK rechaza mayúsculas, barras y NULLs adentro del array; acepta `NULL`,
  `'{}'` y una lista normal
- un empleado **no** puede auto-otorgarse secciones
- un empleado **no** se las cambia a otro. Ojo: acá no salta el trigger sino que
  la policy `user update own profile` hace que el UPDATE matchee **cero filas**.
  El primer test asumió que iba a explotar y falló — el comportamiento estaba
  bien y la aserción estaba mal. Ahora comprueba que el valor no cambió.
- un admin sí, y el `service_role` (el backend) también
- los cuatro guards viejos (sucursal, activo, username, venta sin stock) siguen
  en pie, y un empleado sigue pudiendo editarse el nombre completo
- **meta-test**: se verifica que el helper `rechaza` detecte un falso verde. La
  primera versión restaba 1 al contador "para compensar" la falla esperada del
  meta-test, y esa resta **tapó una falla real**. El helper ya corre en subshell,
  así que la compensación sobraba.

**Playwright**, de punta a punta:
- Se le dejan al empleado sólo **Ventas** y **Stock** desde el diálogo nuevo; en
  la base queda `{ventas,stock}`.
- Entrando con ese usuario: el menú muestra exactamente esos dos, y **aterriza
  solo en `/ventas`** porque no tiene dashboard.
- `/compras/nueva` escrito a mano (ruta HIJA) muestra el panel de sin acceso y
  **no renderiza el formulario**.
- Con `secciones = '{}'`: menú vacío, cartel "no tenés ninguna sección
  habilitada", y **sin loop de navegación**.
- **Ataque real desde el navegador**: `PATCH /rest/v1/profiles` con el token del
  propio empleado → `400 P0001 "Sólo un administrador puede cambiar las secciones
  de un usuario"`, y el valor queda intacto en `{ventas,stock}`.

**Catálogo vs router**: las 18 secciones cubren todas las rutas reales de
`src/routes/_authenticated/`. La única que queda afuera es `/caja`, que sólo
redirige a `/arqueo` y por eso no es una sección (con test).
