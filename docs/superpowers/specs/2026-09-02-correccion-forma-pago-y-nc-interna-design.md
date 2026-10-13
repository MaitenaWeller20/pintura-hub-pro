# Corrección de forma de pago y nota de crédito interna

Fecha: 2026-09-02
Estado: diseño aprobado, pendiente de revisión escrita

## 1. Objetivo

Resolver dos problemas observados en producción sin perder trazabilidad contable:

1. Un administrador debe poder corregir la **forma** de un pago ya registrado en
   una venta. El importe no se edita, no se agregan pagos y no se eliminan pagos.
2. La pantalla de ventas debe volver a permitir una nota de crédito sin factura
   asociada. En el flujo fiscal v2 esa nota es exclusivamente **interna**, no se
   envía a ARCA y no recibe CAE.

La implementación parte de
`origin/deploy/facturacion-multiemisor-2026-08-21` en una rama aislada, porque el
árbol de trabajo principal contiene cambios locales ajenos a esta tarea.

## 2. Diagnóstico confirmado

### 2.1 Forma de pago

La forma efectiva está en `venta_pagos.forma_pago`. El arqueo deriva sus importes
de esas filas mediante `caja_esperado()`, usando como caja efectiva
`COALESCE(venta_pagos.caja_sesion_id, ventas.caja_sesion_id)`.

Actualizar solamente `venta_pagos` sería incorrecto para una caja cerrada: la
venta mostraría la forma nueva, pero `caja_sesiones.esperado`, `diferencia` y sus
totales conservarían el cálculo anterior. Por eso la corrección tiene que abarcar
la fuente comercial, su auditoría y, cuando corresponda, el snapshot del cierre
en una sola transacción.

### 2.2 Nota de crédito sin factura

La capacidad existía desde
`20260813130000_nota_credito_sin_factura.sql`. La migración
`20260823121146_cercar_notas_en_crear_venta.sql` introdujo el cerco fiscal v2 y
pasó a rechazar toda nota de crédito creada por `crear_venta`. En paralelo,
`ventas.nueva.tsx` oculta la opción “Sin factura” cuando v2 está activo, exige una
venta fiscal original y deja ítems, condición e importes en modo de sólo lectura.

Ese cerco es válido para una **nota fiscal asociada**, que debe seguir naciendo de
`anular_venta`, pero también bloqueó por error el caso distinto de una nota
interna sin asociación ni efectos ante ARCA.

## 3. Alcance funcional

### 3.1 Corrección de un pago

Desde el detalle de una venta, un administrador podrá abrir “Corregir forma de
pago” sobre cada pago positivo existente.

El diálogo mostrará:

- número de venta;
- importe del pago, de sólo lectura;
- forma anterior;
- selector de forma nueva;
- motivo obligatorio de entre 5 y 1000 caracteres;
- aviso de que la identidad, la fecha y los valores anterior/nuevo quedarán
  auditados.

Las formas permitidas son `EFECTIVO`, `TRANSFERENCIA`, `TARJETA_DEBITO`,
`TARJETA_CREDITO`, `MERCADO_PAGO` y `CHEQUE`. `CTA_CTE` no es una forma de pago y
no aparece en el selector.

Cada pago se corrige por separado. Esto evita una operación ambigua cuando una
venta tiene pago mixto o cobros parciales realizados en cajas diferentes.

No se permitirá:

- cambiar `monto`;
- agregar o borrar pagos;
- corregir pagos negativos, como devoluciones de una nota de crédito;
- corregir una venta anulada;
- guardar la misma forma que ya tenía;
- guardar desde un usuario no administrador.

Al cambiar de forma se vacía el `detalle` vivo del pago para no dejar, por
ejemplo, un número de cheque asociado a “Efectivo”. El detalle anterior queda
íntegro en la auditoría. Esta pantalla no agrega ni edita datos accesorios del
nuevo medio.

### 3.2 Efecto sobre caja

La caja efectiva del pago es:

```text
venta_pagos.caja_sesion_id ?? ventas.caja_sesion_id
```

- Si la caja está abierta, no se guarda ningún snapshot adicional: el cierre
  posterior leerá automáticamente la forma corregida desde `caja_esperado()`.
- Si la caja está cerrada, la misma RPC vuelve a calcular `esperado`,
  `diferencia`, `total_esperado`, `total_contado` y `total_diferencia`.
  Conserva exactamente `contado.EFECTIVO`, que es el único conteo físico. Para
  cada medio no efectivo vuelve a fijar `contado` igual al nuevo `esperado`, tal
  como hace `cerrar_caja()`: transferencias, tarjetas, Mercado Pago y cheques no
  se cuentan a mano ni deben adquirir diferencias ficticias. `efectivo_dejado`
  y las observaciones permanecen intactos.
- La versión del cierre aumenta. Así, un diálogo de corrección de cierre que
  quedó abierto con datos viejos falla por control optimista en vez de pisar la
  corrección de la venta.
- La corrección automática del cierre se agrega también a
  `caja_cierre_correcciones`, con referencia a la venta y al pago, para que no
  haya saltos invisibles en el historial de versiones.

No se propaga ningún cambio a `efectivo_dejado` ni al fondo de un turno
posterior. Si una corrección cambia el esperado en efectivo, la diferencia del
cierre se vuelve a comparar contra el efectivo que realmente se contó; no se
inventa efectivo físico. Las diferencias de medios no efectivos continúan en
cero por diseño.

### 3.3 Nota de crédito interna sin factura

Con facturación v2 activa, elegir “Nota de Crédito” en “Nuevo comprobante” abre
el modo interno:

- no exige ni ofrece una factura original;
- permite elegir Contado o Cuenta corriente;
- permite cargar los productos devueltos;
- permite indicar cómo se devuelve el dinero cuando es al contado;
- guarda `afip_cbte_asoc_id = NULL` y `afip_estado = 'NO_APLICA'`;
- muestra con claridad “Documento interno, sin CAE; no se envía a ARCA”.

El cliente continúa siendo obligatorio. También continúan las reglas existentes:
la nota debe tener ítems y total distinto de cero; si es de contado debe indicar
una devolución, y si es a cuenta corriente genera el crédito correspondiente.

Las fronteras fiscales no se relajan:

- una nota de crédito **asociada** no puede crearse manualmente en v2;
- la nota fiscal total de una venta aprobada sigue generándose exclusivamente
  desde `anular_venta`, heredando emisor, receptor, identidad y comprobante
  asociado;
- la nota de débito continúa fuera del flujo v2 actual;
- en modo legacy se conserva el selector opcional de factura que ya existía.

## 4. Persistencia y seguridad

### 4.1 Versión y auditoría del pago

Se agrega `venta_pagos.correccion_version integer NOT NULL DEFAULT 0` con control
no negativo.

Se crea `venta_pago_correcciones`, append-only, con:

- `venta_pago_id`, `venta_id` y caja efectiva;
- administrador y fecha de corrección;
- motivo;
- versión anterior y nueva;
- importe congelado;
- forma y detalle anteriores;
- forma y detalle nuevos.

Una restricción única por `(venta_pago_id, version_nueva)` impide duplicar una
versión. Un trigger rechaza `UPDATE` y `DELETE` sobre la auditoría. Los usuarios
autenticados no reciben permisos directos de escritura; sólo los administradores
pueden leerla mediante RLS.

### 4.2 RPC autoritativa

La única escritura pública será `corregir_forma_pago_venta(...)`, una RPC
`SECURITY DEFINER`. Recibirá el pago, la forma nueva, el motivo y la versión que
vio la pantalla.

La RPC:

1. autentica y exige administrador;
2. bloquea la venta y el pago;
3. valida estado, signo, versión y forma permitida;
4. toma el lock de caja siguiendo el protocolo vigente de la sucursal;
5. actualiza únicamente `forma_pago`, `detalle` y `correccion_version`;
6. inserta la auditoría del pago;
7. si la sesión está cerrada, recalcula y versiona el cierre e inserta su entrada
   de auditoría;
8. confirma todo junto o revierte todo junto.

El servidor verifica la versión esperada después de tomar los locks. Dos
administradores que abran el mismo pago no pueden sobreescribirse silenciosamente.

### 4.3 Ajuste del cerco de notas

Una nueva migración redefine la versión vigente de `crear_venta` conservando su
cuerpo y permisos actuales, salvo la matriz inicial de notas:

- `NOTA_CREDITO` con `p_cbte_asoc_id IS NULL`: permitida como interna aunque el
  escritor v2 esté activo;
- `NOTA_CREDITO` asociada con v2: rechazada con instrucción de usar
  `anular_venta`;
- notas legacy: comportamiento vigente;
- `NOTA_DEBITO` con v2: continúa rechazada.

## 5. Interfaz

`DialogoDetalleVenta` recibirá el permiso administrativo desde la lista de
ventas. Cada pago positivo de una venta activa tendrá una acción accesible para
abrir el diálogo de corrección. Después de guardar se invalidan el detalle, la
lista de ventas y las consultas de caja relacionadas.

El administrador podrá abrir el historial del pago desde el mismo bloque. Cada
entrada mostrará importe, forma anterior/nueva, autor, fecha y motivo.
El historial del cierre también distinguirá una corrección originada en una
venta y mostrará número de venta, importe y forma anterior/nueva, además del
cambio resultante en esperado y diferencia.

La pantalla de nueva venta separará explícitamente estos dos conceptos:

- **NC interna manual:** se carga aquí, sin factura y sin CAE;
- **NC fiscal:** se genera al anular la venta facturada correspondiente.

No se reutiliza el editor completo de pagos para la corrección porque ese editor
también habilita montos, altas y bajas, operaciones fuera del alcance aprobado.

## 6. Manejo de errores

Los errores esperables tendrán mensajes accionables:

- permiso insuficiente;
- venta o pago inexistente;
- venta anulada;
- pago no corregible;
- forma nueva inválida o sin cambios;
- motivo insuficiente;
- versión desactualizada;
- cierre histórico incompatible con el recálculo.

La interfaz conserva el diálogo abierto ante un error y permite revisar la
selección. No presenta errores internos de Postgres como mensajes de negocio.

## 7. Pruebas

### 7.1 Base de datos

Un script transaccional cubrirá:

- un empleado no puede corregir;
- sólo cambia la forma del pago elegido y el importe permanece idéntico;
- el detalle anterior queda auditado y el vivo se limpia;
- una versión desactualizada falla;
- la auditoría no admite modificación ni borrado;
- una venta anulada, un pago negativo y `CTA_CTE` son rechazados;
- en caja abierta, `caja_esperado()` refleja la forma nueva;
- en caja cerrada, se recalculan esperado y diferencia, se conserva el efectivo
  contado, los medios no efectivos vuelven a igualarse al esperado y no cambia
  el efectivo dejado;
- el cierre incrementa su versión y registra la referencia a venta/pago;
- una nota interna sin factura se crea con v2 activo y queda `NO_APLICA`;
- una nota manual asociada sigue rechazada en v2;
- `anular_venta` conserva la creación de la nota fiscal asociada.

### 7.2 Aplicación

Pruebas unitarias cubrirán validación y decisiones de interfaz:

- el selector excluye `CTA_CTE`;
- no se puede guardar sin cambio o sin motivo válido;
- el modo NC interna v2 no requiere comprobante original y deja editables ítems,
  condición y pagos;
- el modo legacy conserva su comportamiento.

Finalmente se ejecutarán las pruebas dirigidas, la suite completa de Vitest,
`npm run typecheck`, `npm run lint` y `npm run build`.

## 8. Fuera de alcance

- editar importes;
- agregar o eliminar pagos históricos;
- cambiar una venta entre Contado y Cuenta corriente;
- corregir devoluciones o notas de crédito ya emitidas;
- emitir ante ARCA una nota sin comprobante asociado o período informado;
- notas de crédito parciales fiscales en v2;
- modificar datos accesorios del nuevo medio de pago.
