# Nota de crédito fiscal sin factura puntual (`PeriodoAsoc`)

**Fecha:** 28/08/2026

**Estado:** diseño aprobado en conversación; pendiente de revisión del documento

**Clasificación:** cambio arquitectónico, porque atraviesa UI, autorización, modelo fiscal,
persistencia comercial, stock, caja, cuenta corriente y recuperación ante respuestas inciertas.

## 1. Objetivo

Permitir emitir una **nota de crédito con CAE y validez fiscal** sin elegir una factura puntual
de Quimex. La nota se asociará ante ARCA a un período desde/hasta y cubrirá, mediante dos modos
separados:

1. **Devolución de productos:** el cliente devuelve mercadería y, una vez confirmado el CAE,
   el stock vuelve a la sucursal.
2. **Bonificación o ajuste comercial:** se acredita un concepto e importe sin mover stock.

El cambio mantiene sin modificaciones el flujo vigente de **reversión total de una factura
específica**.

## 2. Fundamento fiscal

Una nota de crédito no puede enviarse a ARCA sin ninguna asociación. Para comprobantes de
crédito o débito, WSFEv1 exige informar **al menos un comprobante asociado (`CbtesAsoc`) o un
período asociado (`PeriodoAsoc`)**. La validación 10197 lo establece expresamente; las
validaciones 10199, 10203, 10207 y 10208 exigen ambas fechas, orden correcto y que el final no
sea posterior a la emisión.

Fuente: [Manual para el desarrollador WSFEv1 v4.6 de ARCA](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf),
validaciones 10197–10208.

Por lo tanto, en la interfaz se dirá **“Sin factura puntual — asociar por período”**, no “sin
asociación”. El usuario deberá seleccionar un período real correspondiente a las operaciones
que está ajustando.

`PeriodoAsoc` usa el mismo servicio WSFEv1 con el que se solicita el CAE. No requiere un
certificado separado para esta modalidad; cada CUIT emisor sí debe conservar vigente y
autorizado su certificado de WSFE, igual que para emitir facturas.

## 3. Alcance

### Incluido

- NC A, B o C de producción con CAE, según emisor y receptor.
- Asociación fiscal por período, con fecha desde y hasta obligatorias.
- Los dos modos separados: devolución de productos y bonificación/ajuste.
- Reintegro completo por medios de pago o crédito completo en cuenta corriente.
- Permiso específico, inicialmente disponible sólo para administradores.
- Auditoría del autor, motivo, período, datos fiscales y efectos comerciales.
- Recuperación idempotente frente a timeout o respuesta incierta de ARCA.
- PDF y detalle de venta con modalidad, motivo y período asociado.

### Fuera de alcance

- Notas de débito sin factura puntual.
- Mezclar productos y conceptos libres en una misma NC.
- Más de un concepto libre en una NC de bonificación/ajuste.
- Percepciones u otros tributos en una NC por período; en esta primera versión serán cero.
- Moneda distinta de pesos.
- Facturas de Crédito Electrónicas MiPyMEs: ARCA no admite `PeriodoAsoc` para FCE
  (validación 10196). Si una operación requiriera FCE, el sistema la bloqueará con un mensaje
  claro y no intentará emitirla.
- Importar o reconstruir facturas históricas para simular una asociación puntual.
- Editar o borrar un comprobante después de obtener CAE.

## 4. Alternativas consideradas

### A. Dos modos excluyentes — elegida

Cada nota representa una devolución física o un ajuste comercial. Las reglas de stock son
inequívocas, el resumen de confirmación puede explicar el efecto exacto y la auditoría no
depende de interpretar cada renglón.

### B. Mezclar productos y conceptos en la misma nota

Es más flexible, pero aumenta las combinaciones fiscales, los errores de stock y la dificultad
para explicar y auditar el efecto. No hay un caso de negocio confirmado que justifique esa
complejidad ahora.

### C. Agregar a cada línea un interruptor “mueve stock”

Es la opción más propensa a errores: una selección accidental cambia inventario y deja al
usuario como responsable de una regla que el sistema puede deducir por modalidad. Se descarta.

## 5. Flujo de usuario

### 5.1 Selección inicial

Al elegir **Nota de crédito**, la pantalla mostrará dos caminos:

- **Revertir una factura específica:** conserva el flujo actual de reversión total, receptor
  heredado y `CbtesAsoc`.
- **Sin factura puntual — asociar por período:** abre el nuevo flujo.

El segundo camino sólo se mostrará habilitado si el usuario posee el permiso correspondiente.
No se reutilizará la opción histórica “Sin factura — documento interno” del escritor legacy:
con facturación v2 activa, el nuevo camino siempre intenta obtener CAE.

### 5.2 Datos comunes de una NC por período

Se exigirán:

- sucursal;
- cliente comercial;
- receptor fiscal confirmado y validado mediante el flujo vigente del padrón;
- período desde/hasta, ambos elegidos conscientemente y sin valores precargados;
- motivo no vacío, con un mínimo de 5 caracteres útiles;
- modalidad de la nota;
- forma de resolución: reintegro o saldo a favor.

Las fechas deberán cumplir `desde <= hasta <= fecha de emisión`. La UI validará primero y la
RPC repetirá la validación de forma autoritativa. El receptor, la letra y el tipo ARCA se
resolverán con las mismas reglas vigentes para facturas; no se elegirán manualmente.

Se reutilizará el selector fiscal vigente: **Cliente comercial** u **Otro receptor**, y ambos
caminos deberán pasar por la validación del padrón. El cliente comercial seguirá siendo el
dueño de los movimientos contables. Si se elige otro receptor y además saldo a favor, la
confirmación mostrará por separado el receptor fiscal y el titular de la cuenta corriente para
evitar una acreditación accidental a la ficha equivocada.

### 5.3 Devolución de productos

- Se seleccionan uno o más productos del catálogo.
- Cada línea exige producto, cantidad positiva, precio unitario sin IVA y alícuota.
- Se permite indicar el precio histórico de la devolución; se conserva también el precio de
  lista para auditar cualquier diferencia, siguiendo el patrón actual.
- No se admiten líneas de concepto libre.
- El resumen muestra explícitamente **“El stock aumentará en esta sucursal cuando ARCA otorgue
  el CAE”** y detalla las cantidades.

### 5.4 Bonificación o ajuste comercial

- Se carga exactamente una línea con descripción, importe sin IVA y alícuota.
- La línea tendrá `producto_id = NULL` y no producirá ningún movimiento de inventario.
- El resumen muestra explícitamente **“Esta nota no modifica stock”**.

### 5.5 Resolución económica

Las dos modalidades permiten exactamente una de estas opciones:

- **Reintegrar dinero:** uno o más medios de pago cuyo total sea exactamente igual al total de
  la NC. Requiere una caja abierta cuando alguno de esos medios afecta caja.
- **Generar saldo a favor:** no recibe pagos y registra el importe completo como crédito en la
  cuenta corriente del cliente.

No se admite una NC parcialmente reintegrada ni una mezcla de reintegro y saldo a favor en la
primera versión. Así no queda un remanente sin representación contable.

### 5.6 Confirmación

Antes de enviar, un diálogo mostrará:

- cliente y CUIT;
- letra prevista;
- período asociado;
- modalidad y motivo;
- neto, IVA y total;
- efecto exacto sobre stock;
- salida por cada medio de pago o crédito en cuenta corriente.

El usuario confirmará que revisó los datos y que el período corresponde a las operaciones que
se están ajustando.

## 6. Modelo de datos

### 6.1 Venta

Las NC por período seguirán siendo filas de `ventas` con `tipo_comprobante = 'NOTA_CREDITO'`.
Se agregarán datos explícitos, no escondidos en `observaciones`:

- modalidad: `DEVOLUCION_PRODUCTOS` o `BONIFICACION_AJUSTE`;
- `periodo_asoc_desde`;
- `periodo_asoc_hasta`;
- `motivo_nota_credito`.

Las restricciones de base exigirán para una NC fiscal exactamente una asociación:

- `afip_cbte_asoc_id` para la reversión puntual, **o**
- las dos fechas del período para la NC por período,

pero nunca ambas. Las facturas ordinarias no podrán tener período asociado.

### 6.2 Líneas

Se reutiliza `venta_items`, que ya admite `producto_id` nulo para conceptos libres:

- devolución: todas las líneas tienen `producto_id`;
- ajuste: existe una única línea y su `producto_id` es nulo.

La modalidad se valida en TypeScript y nuevamente dentro de la RPC. No se confía en los datos
del navegador para decidir si una línea mueve stock.

### 6.3 Permiso

`profiles` incorporará un permiso específico para emitir NC por período. La regla efectiva
será **administrador o permiso asignado**. El valor predeterminado será falso, por lo que al
desplegar sólo los administradores podrán usarlo. La pantalla de Usuarios permitirá que un
administrador lo otorgue posteriormente a un encargado sin cambiar su rol general.

La autorización se verificará tanto en UI como en la RPC `SECURITY DEFINER`; ocultar el control
en el navegador no será la barrera de seguridad.

## 7. Snapshot fiscal y payload ARCA

El snapshot fiscal v2 existente es canónico, tiene claves exactas y está firmado con hash. No
se modificará su interpretación retroactivamente.

Se introducirá un snapshot v3 para las NC por período. Mantendrá los datos fiscales v2 y
agregará de forma canónica:

- origen `PERIODO_ASOCIADO`;
- `periodoAsoc: { desde, hasta }`;
- modalidad y motivo de la NC;
- `comprobanteOriginalId = null`;
- `cbtesAsoc = []`.

La validación v3 exigirá la exclusión mutua entre `cbtesAsoc` y `periodoAsoc`, las fechas
válidas, la coherencia con la fila `ventas`, el receptor confirmado, los importes y las reglas
de líneas de cada modalidad. Los snapshots v2 ya persistidos seguirán validándose exactamente
como hoy.

El adaptador WSFE dejará de aceptar dos propiedades opcionales independientes y usará una
unión discriminada de asociación:

- ninguna, sólo para facturas;
- comprobante, serializada como `CbtesAsoc`;
- período, serializada como `PeriodoAsoc` con `FchDesde` y `FchHasta` en `YYYYMMDD`.

Para una NC será imposible construir un request sin asociación o con ambas asociaciones. Las
pruebas inspeccionarán el objeto entregado al SDK para verificar que no se pierda el período.

## 8. Persistencia y atomicidad

Se extenderá el flujo fiscal v2 existente, no se creará un segundo emisor:

1. Una RPC idempotente valida permiso, cliente, período, modalidad, líneas, totales y forma de
   resolución; luego crea la NC pendiente sin aplicar efectos comerciales.
2. La cola fiscal reclama la fila, consulta la secuencia, reserva número y persiste el snapshot
   v3 con hash.
3. El adaptador solicita el CAE incluyendo `PeriodoAsoc`.
4. Sólo cuando el estado llega a `APROBADO`, la transición final persiste en una única
   transacción:
   - CAE e identidad fiscal;
   - movimiento `DEVOLUCION` y aumento de `stock_sucursal`, sólo para productos;
   - salida de caja/pagos, o crédito de cuenta corriente;
   - referencias de auditoría.
5. La misma transición es idempotente: recuperar un CAE tras un timeout no duplica stock,
   dinero ni saldo.

Un rechazo, error corregible, indisponibilidad o estado incierto no modifica stock, caja ni
cuenta corriente. Si una consulta posterior confirma que ARCA sí autorizó, recién entonces se
ejecuta el paso 4.

## 9. Auditoría e inmutabilidad

La trazabilidad se apoyará en fuentes autoritativas ya existentes y en los nuevos campos:

- `ventas.usuario_id` y fecha de creación identifican al operador;
- modalidad, motivo y período quedan en `ventas`;
- receptor, importes, líneas, asociación e identidad quedan inmóviles en el snapshot con hash;
- `emision_fiscal_intentos` conserva reclamos, requests, resultados y recuperaciones;
- `stock_movimientos`, `caja_movimientos` y `cuenta_corriente_movimientos` registran cada
  efecto con referencia a la NC y al usuario.

El detalle consultable de la NC reunirá esos datos para mostrar quién la creó, qué hizo, por
qué, a qué período corresponde, qué autorizó ARCA y qué movimientos produjo. No se duplicará
la misma verdad en una segunda tabla de auditoría sin necesidad.

Una NC con CAE no se edita ni se borra. Una NC pendiente que todavía no reservó número ni
inició un request fiscal se puede cancelar y recrear; no se edita en el lugar. Después de
reservar número, cualquier incertidumbre se resuelve por conciliación. La corrección de una NC
aprobada requiere otro comprobante fiscal y no forma parte de este alcance.

## 10. Errores visibles

Nunca se expondrán objetos de Zod, SOAP, JSON técnico ni trazas al usuario.

- Validaciones del formulario: mensaje junto al campo, por ejemplo “Elegí la fecha desde del
  período asociado” o “El reintegro debe coincidir con el total de la nota”.
- Rechazo fiscal: razón de ARCA traducida a lenguaje claro, conservando código y detalle en la
  auditoría técnica.
- Caída confirmada antes de que el request pueda quedar autorizado:
  **“ARCA está caída. No se pudo emitir la nota de crédito. Intentá nuevamente en otro
  momento.”**
- Timeout o corte después de iniciar el request:
  **“ARCA está caída y estamos verificando si autorizó la nota. No vuelvas a emitirla.”**
  La fila pasa a conciliación y no ofrece un reintento ciego.
- Certificado vencido o no autorizado: se informa que la configuración fiscal del emisor debe
  corregirse; no se lo clasifica como una caída transitoria ni se reintenta indefinidamente.
- FCE incompatible con período: se explica que esa operación necesita asociar comprobantes
  puntuales y no se envía un payload que ARCA rechazará.

## 11. Pruebas y criterios de aceptación

### Unitarias

- Validación de fechas y modalidad.
- Productos obligatorios para devolución y prohibidos para ajuste.
- Concepto único sin producto para ajuste.
- Cálculo neto/IVA/total y liquidación exacta.
- Unión de asociación: factura sin asociación, NC puntual con `CbtesAsoc`, NC por período con
  `PeriodoAsoc`; combinaciones inválidas rechazadas.
- Snapshot v3 canónico, hash estable, detección de alteraciones y compatibilidad de lectura v2.
- Traducción de errores y clasificación transitoria/definitiva/incierta.

### Integración de base

- Empleado sin permiso rechazado aunque invoque la RPC directamente.
- Administrador y usuario autorizado aceptados.
- Idempotencia ante doble envío.
- Ningún efecto comercial antes del CAE.
- Devolución aprobada aumenta stock exactamente una vez.
- Ajuste aprobado no toca stock.
- Reintegro aprobado genera la salida exacta; cuenta corriente genera el crédito exacto.
- Rechazo y caída no generan movimientos.
- Recuperación de CAE tras timeout persiste efectos exactamente una vez.
- Restricciones de asociación impiden período más comprobante o NC sin ninguno.
- La reversión total vigente sigue funcionando sin cambios.

### UI/E2E

- Selector entre reversión puntual y asociación por período.
- Los dos modos muestran sólo sus campos pertinentes.
- Período y motivo obligatorios, confirmación con efectos correctos.
- Permiso oculto y bloqueado en servidor.
- Mensajes humanos para validación, rechazo, caída e incertidumbre.
- Detalle y PDF muestran período, motivo, modalidad y CAE.

### Homologación ARCA

Antes de habilitar producción se emitirán, con CUIT y punto de venta de homologación:

- una NC por período de devolución;
- una NC por período de bonificación/ajuste;
- los tipos A, B y C que correspondan a los emisores configurados;
- una recuperación mediante consulta luego de simular timeout posterior al request.

Se verificará en la respuesta y consulta posterior que el CAE, número, receptor, importes y
período coincidan. No se habilitará el flag productivo sólo con pruebas mock.

## 12. Despliegue

1. Migración compatible hacia adelante: campos, restricciones, permiso y RPC.
2. Código capaz de leer snapshots v2 y v3.
3. Pruebas unitarias, integración, lint, typecheck, build y E2E mock.
4. Prueba real en homologación por cada configuración fiscal relevante.
5. Despliegue con la opción deshabilitada por flag.
6. Verificación de migración, certificados WSFE y cola fiscal en producción.
7. Habilitación primero para administradores y seguimiento de las primeras emisiones.

La activación puede revertirse apagando el flag sin borrar comprobantes ni reescribir
historial. No se hará force-push, rebase ni modificación de commits publicados por la
integración con Lovable.

## 13. Resultado esperado

Un administrador puede emitir una NC A/B/C con CAE sin elegir una factura puntual, declarando
un período válido. Si es devolución, el stock vuelve exactamente una vez después del CAE; si
es ajuste, nunca cambia. La salida de dinero o el saldo a favor queda completamente
representado, el comprobante es inmutable y toda la operación puede reconstruirse por usuario,
motivo, período, evidencia fiscal y movimientos comerciales.
