# Venta, cobro y facturación con receptor fiscal independiente

- **Fecha:** 2026-08-21
- **Estado:** diseño aprobado; plan de implementación listo
- **Proyecto:** PinturaGest / Quimex
- **Referencia funcional:** circuito de cobro y pendientes de `lubricentro-sistema`

## 1. Objetivo

Separar en el uso diario la operación comercial de su emisión fiscal, sin duplicar la fuente de
verdad que hoy protege la numeración y el CAE.

Una venta ordinaria tendrá dos cierres:

1. **Registrar venta y facturar:** registra venta, pagos o deuda, caja y stock; luego intenta emitir
   inmediatamente al receptor fiscal confirmado.
2. **Registrar sin facturar:** registra exactamente los mismos efectos comerciales y deja la venta
   en una cola durable para elegir receptor y emitir después.

El comprador/deudor y el receptor fiscal pueden ser distintos. Facturar a otro CUIT/CUIL no cambia
el cliente comercial, la cuenta corriente, los pagos, el stock ni los reportes de venta.

## 2. Decisiones aprobadas

- La venta comercial existe aunque todavía no tenga factura.
- `ventas.cliente_id` conserva al comprador/deudor.
- El receptor se elige por comprobante y se congela antes de reservar un número en ARCA.
- El receptor puede ser manual de una sola vez o guardarse de manera opt-in para reutilizarlo.
- Guardar un receptor fiscal no crea ni modifica un cliente comercial.
- La emisión inmediata y la emisión desde la cola usan el mismo diálogo y el mismo motor.
- **Registrar sin facturar** no abre ese diálogo ni exige receptor.
- La factura es por el total de la venta, aunque el cobro sea parcial o vaya a cuenta corriente.
- Un cobro posterior sólo cambia pagos y saldo; nunca modifica la factura ni crea otra.
- Si ARCA falla después de registrar la venta, caja/deuda y stock permanecen. La factura queda
  pendiente o en conciliación; la venta no se vuelve a cargar ni cobrar.
- La letra no es libre: se deriva de la condición real del receptor y se valida en servidor.
- Sólo se soporta Factura A estándar.
- Quimex no copiará el mayor de doble partida del lubricentro. Sí conserva su invariante útil:
  registrar la operación mueve caja/deuda y stock una vez; facturar después no repite efectos.

## 3. Situación actual y referencia del lubricentro

Hoy `/ventas/nueva` mezcla cliente, A/B, productos y pagos en un formulario con un único botón
**Guardar**. La RPC `crear_venta` registra en una transacción:

- venta e ítems;
- pagos o deuda;
- caja;
- movimientos de stock;
- número interno de mostrador.

ARCA se llama después, desde un icono en `/ventas` que recibe sólo `venta_id`. En ese momento el
receptor se relee de `ventas.cliente_id`. No existe una cola fiscal completa: el listado general
trae solamente las últimas 200 ventas.

La emisión actual ya contiene controles que se deben preservar:

- reserva local antes del pedido de CAE;
- snapshot;
- claim anti doble clic;
- consulta del comprobante ante incertidumbre;
- recuperación de un CAE;
- índice único por CUIT emisor, PV, tipo, número, ambiente y simulación.

Del lubricentro se toman los dos cierres, la cola, el outbox durable y la regla de no repetir stock o
cobro. No se copia su acoplamiento cliente-receptor, su booleano A/B ni su regla fiscal vieja.

## 4. Arquitectura elegida

### 4.1 Una sola fuente fiscal

La separación será lógica y de interfaz, pero no se creará una segunda tabla autoritativa de CAE.
Los campos `afip_*`, `cae`, `cae_vencimiento` y `afip_snapshot` de `ventas` seguirán siendo la única
fuente de verdad fiscal.

Esta decisión evita:

- migrar CAE históricos a una tabla paralela;
- dos índices que no puedan impedir duplicados entre tablas;
- una ventana de deploy con dos escritores fiscales;
- romper la recuperación, impresión y notas ya desplegadas.

Cada fila de `ventas` representa una operación comercial y, como máximo, un comprobante fiscal.
Una NC o ND continúa siendo su propia fila de `ventas` y referencia al original mediante
`afip_cbte_asoc_id`.

### 4.2 Tipo comercial neutral

Se agrega `VENTA` al enum `tipo_comprobante` para ventas positivas ordinarias nuevas. No significa
Factura A ni B. Su número se rotula como **N.º de venta**.

El comprobante fiscal real se obtiene de `afip_cbte_tipo` y del snapshot:

- 1/6/11: factura A/B/C;
- 2/7/12: nota de débito A/B/C;
- 3/8/13: nota de crédito A/B/C.

`tipo_comprobante=VENTA` permanece neutral después del CAE; no se reescribe. La interfaz muestra por
separado **Venta V-…** y **Factura A/B PV-número**.

Alcance:

- ventas positivas ordinarias: `VENTA` y los dos cierres;
- remitos, remitos de obra y documentos internos: conservan su tipo y un único **Guardar**;
- NC/ND: conservan su tipo, se asocian al comprobante original y no eligen receptor;
- las A/B/C históricas no se reescriben.

Toda función que decida si algo es fiscal debe usar una allowlist explícita; un enum desconocido no
puede considerarse fiscal por descarte.

## 5. Modelo de datos

### 5.1 Venta y estado fiscal embebido

`ventas` sigue siendo la fuente comercial y fiscal. Se reutilizan sus columnas actuales y se agregan
los mínimos campos de control:

- `afip_estado` con estados explícitos;
- `afip_fecha_comprobante date`;
- `afip_snapshot jsonb` versionado;
- `afip_snapshot_hash text` del payload canónico;
- `afip_claim_token uuid` y `afip_claimed_at timestamptz`;
- `afip_fase`: `PREFLIGHT | RESERVADO | REQUEST_INICIADO | RESPUESTA_RECIBIDA | PERSISTIDO`;
- `afip_error_clase`, `afip_error_codigo`, `afip_error_fase` y `afip_ultimo_error_at`;
- `afip_validez`: `PRODUCCION | HOMOLOGACION | SIMULADA`.
- `afip_legacy_incompleto boolean NOT NULL DEFAULT false`, reservado al backfill histórico.

Se preservan como identidad autoritativa `afip_emisor_cuit`, `afip_punto_venta`, `afip_cbte_tipo`,
`afip_numero`, `afip_modo`, `afip_simulado`, `cae`, `cae_vencimiento`, `afip_emitido_at`,
`afip_intentos` y `afip_cbte_asoc_id`.

`afip_validez` debe ser coherente con modo y simulación. Sólo `PRODUCCION` tiene validez legal y puede
originar una nota de producción.

### 5.2 Estados

```text
NO_APLICA

SIN_FACTURAR
    │
    ├──> EMITIENDO ───> APROBADO
    │         │
    │         ├──> ERROR_CORREGIBLE
    │         └──> RECONCILIAR
    │
    ├──> CANCELADO
    └──> BLOQUEADO
```

- `NO_APLICA`: remito, documento interno u operación no fiscal.
- `SIN_FACTURAR`: venta válida sin número reservado; puede no tener receptor todavía.
- `EMITIENDO`: snapshot reclamado por un token con lease vigente.
- `APROBADO`: ARCA devolvió CAE y toda la identidad quedó persistida.
- `ERROR_CORREGIBLE`: rechazo definitivo o preflight fallido, sin autorización incierta.
- `RECONCILIAR`: pudo haberse enviado el pedido y no se conoce con certeza el resultado.
- `CANCELADO`: venta anulada antes de solicitar un comprobante fiscal.
- `BLOQUEADO`: legado incompleto, divergencia o incidente de integridad que exige resolución admin.

Invariantes:

- `APROBADO` exige siempre CAE y número; los nuevos exigen además fecha, validez y snapshot v2
  completo, mientras un histórico puede conservar `afip_legacy_incompleto=true` sin inventar datos
  faltantes;
- `RECONCILIAR` exige snapshot y número reservado;
- un `EMITIENDO` vencido con número pasa a conciliación;
- un `EMITIENDO` vencido sin número se puede liberar sólo tras verificar que nunca se envió;
- `CANCELADO` no puede tener CAE;
- si hay número reservado o incertidumbre, no se editan receptor, fecha, montos, emisor ni PV;
- la anulación bloquea la fila y se rechaza durante `EMITIENDO` o `RECONCILIAR`.

Estas invariantes se aplican en base con `CHECK` para combinaciones locales y una única función de
transición para estado/fase/claim. La función valida la transición anterior, token, campos
obligatorios, coherencia entre `afip_validez`, modo y simulación, e inmutabilidad después de reserva.
No se confía sólo en validaciones TypeScript.

### 5.3 Intentos auditables

Una tabla interna `emision_fiscal_intentos` audita cada intento sin convertirse en fuente de CAE:

- `venta_id`, `claim_token`, `snapshot_version`, `payload_hash`;
- fase y resultado;
- número reservado si existió;
- código/clase del error;
- timestamps;
- resumen de respuesta con datos sensibles enmascarados.

No guarda clave privada, certificado, ticket de acceso ni SOAP completo. Sólo `service_role` escribe
y lee; no se expone al navegador.

### 5.4 Receptores reutilizables

Nueva tabla auxiliar `receptores_fiscales`:

- `id`;
- `sucursal_id` obligatoria, como límite de visibilidad operativa;
- `creado_por`;
- `cliente_comercial_id` opcional para ofrecerlo como favorito de ese cliente;
- `tipo_documento`: `CUIT | CUIL | DNI | CDI`;
- `numero_documento` canónico;
- `razon_social`;
- `condicion_iva`;
- `domicilio` opcional;
- `activo` y auditoría.

Es sólo una ayuda de carga. La factura nunca relee un favorito durante un reintento. El snapshot puede
registrar su ID como origen, pero copia todos los valores. Desactivar o editar el favorito no modifica
comprobantes. La referencia auxiliar usa `ON DELETE SET NULL` o queda únicamente dentro del snapshot;
nunca debe impedir conservar historia fiscal. Un empleado sólo ve favoritos de su sucursal; el admin
puede verlos todos.

El consumidor final anónimo no se guarda como favorito.

### 5.5 Snapshot fiscal v2

Antes de reservar el número se crea un payload canónico inmutable con:

- versión y hash;
- venta e ítems ordenados;
- emisor, CUIT, razón social y domicilio;
- sucursal, PV numérico, ambiente y validez;
- receptor fiscal;
- letra, `cbte_tipo`, concepto y condición IVA enviada;
- documento lógico y `DocTipo/DocNro` exactos enviados a ARCA;
- neto, IVA por alícuota, tributos, total y moneda en decimales canónicos;
- fecha fiscal;
- `CbtesAsoc` completo si es nota;
- valores separados para `IVA Contenido` y `Otros Impuestos Nacionales Indirectos`.

Receptor:

```ts
type ReceptorFiscalSnapshot = {
  razonSocial: string;
  domicilio: string | null;
  tipoDocumento: "CUIT" | "CUIL" | "DNI" | "CDI" | "SIN_IDENTIFICAR";
  numeroDocumento: string | null;
  docTipoArca: 80 | 86 | 87 | 96 | 99;
  docNroArca: string;
  condicionIva: "RESPONSABLE_INSCRIPTO" | "MONOTRIBUTO" | "EXENTO" | "CONSUMIDOR_FINAL";
  origen: "CLIENTE_COMERCIAL" | "FAVORITO" | "MANUAL" | "ARCA";
  origenId: string | null;
  verificadoArcaAt: string | null;
};
```

Mapeo documental:

- CUIT: 80;
- CUIL: 86;
- CDI: 87;
- DNI: 96;
- consumidor final sin identificar: 99/0.

No se infiere CUIT/CUIL/CDI por tener once dígitos.

Un rechazo definitivo y confirmado puede liberar la identidad reservada de forma atómica y permitir
una nueva revisión del snapshot. El intento anterior queda en auditoría. `RECONCILIAR` y `APROBADO`
nunca releen datos vivos.

### 5.6 Fecha comercial y fecha fiscal

`ventas.fecha` permanece como fecha comercial. `afip_fecha_comprobante` es la fecha fiscal y se fija
al iniciar el primer pedido a ARCA.

Para esta primera versión, Quimex vende productos (`Concepto=1`) y aplica estas reglas:

- la fecha fiscal predeterminada es el día actual en `America/Argentina/Cordoba`;
- no se copia ni se retrodata automáticamente a `ventas.fecha`;
- antes de reservar se obtiene el último número con `FECompUltimoAutorizado` y su fecha mediante
  `FECompConsultar(ultimoNro)` para el mismo CUIT/PV/tipo;
- la nueva fecha no puede ser anterior a la última fecha autorizada de esa secuencia;
- una configuración con último comprobante fechado en el futuro se bloquea para revisión;
- una venta comercial de más de cinco días muestra advertencia de demora y requiere confirmación
  administrativa; si se emite, lo hace con la fecha actual, no con una fecha inventada;
- durante `EMITIENDO` o `RECONCILIAR` la fecha queda congelada;
- tras rechazo definitivo sin reserva incierta, un nuevo intento crea snapshot y fecha nuevos.

El manual WSFE permite para productos una fecha hasta cinco días anterior o posterior al pedido, sin
exceder el mes. Usar la fecha real del intento evita que una venta vieja quede técnicamente muerta,
pero la advertencia deja visible la regularización contable pendiente.

## 6. Reglas fiscales A/B

Para emisor Responsable Inscripto:

| Receptor              | Letra |
| --------------------- | ----- |
| Responsable Inscripto | A     |
| Monotributo           | A     |
| Exento                | B     |
| Consumidor Final      | B     |

Reglas:

- A siempre exige CUIT válido y `DocTipo=80`.
- No existe downgrade manual de RI o monotributista a B.
- A monotributista incluye la leyenda de Ley 27.618 en factura, NC y ND.
- B a consumidor final aplica el umbral de identificación vigente como regla versionada por fecha.
- El umbral vigente desde 2026 es ARS 10.000.000; se prueban importes debajo, iguales y encima.
- La UI muestra la letra calculada y el servidor la recalcula.
- Un emisor monotributista futuro emitiría C; no forma parte del rollout actual.

Esto reemplaza explícitamente reglas viejas hoy presentes en `codigos.ts`, `fiscal.functions.ts`,
`crear_venta` y sus pruebas: monotributista ya no deriva B y no se puede forzar B a RI.

## 7. Experiencia de uso

### 7.1 Nueva venta

Una venta neutral muestra:

- **Registrar venta y facturar** — acción principal;
- **Registrar sin facturar** — acción secundaria.

Antes del cierre se resume:

```text
Total: $169.482,00
Cobrado ahora: $100.000,00
Saldo pendiente: $69.482,00

La factura se emite por el total. Facturar no cobra ni cancela el saldo.
```

Si es cuenta corriente se muestra **Va a cuenta corriente**. Remitos e internos conservan un único
**Guardar**.

### 7.2 Diálogo compartido

El diálogo se abre al elegir emisión inmediata o **Facturar** desde la cola:

1. comprador/deudor, sólo lectura;
2. emisor, CUIT, sucursal, PV y ambiente, sólo lectura;
3. **Facturar a:** cliente comercial, receptor guardado u otro;
4. documento, razón social, condición IVA y domicilio para otro receptor;
5. checkbox **Guardar para próximas facturas**;
6. letra calculada y motivo;
7. fecha comercial, fecha fiscal y aviso si existe demora;
8. total fiscal, cobrado y saldo;
9. confirmación final.

Ejemplo:

```text
Venta/deuda: Juan Pérez
Factura A: ACME S.A. — CUIT 30-12345678-9
Emisor: Aplicaciones y Servicios S.R.L. — PV 00005
Total facturado: $169.482,00

El cobro y la deuda permanecen asociados a Juan Pérez.
```

El botón se bloquea mientras el servidor procesa y muestra **Emitiendo en ARCA…**.

Para NC/ND se reutiliza la presentación y el motor, pero el receptor heredado del comprobante
original aparece sólo lectura: nunca se ofrecen cliente, favorito ni receptor manual.

### 7.3 Carga y consulta de identidad

Primera entrega:

- busca en cliente y favoritos;
- valida tipo y dígitos del documento;
- permite 99/0 para consumidor final debajo del umbral;
- exige razón social y condición IVA si no hay datos conocidos;
- pide confirmación expresa cuando los datos son manuales.

La consulta automática a `ws_sr_constancia_inscripcion` es una mejora posterior, cuando cada emisor
tenga el servicio relacionado. Una falla técnica de padrón nunca se presenta como “CUIT inexistente”.

### 7.4 Cola operativa

La cola se separa de la configuración de credenciales ARCA y usa paginación/filtros de servidor, sin
límite oculto de 200 ni corte por antigüedad.

| Estado                         | Pestaña    | Acción                                 |
| ------------------------------ | ---------- | -------------------------------------- |
| `SIN_FACTURAR`                 | Pendientes | Facturar                               |
| `EMITIENDO` reciente           | Pendientes | Procesando; refresco, sin acción       |
| `EMITIENDO` vencido sin número | A revisar  | Liberar claim verificado               |
| `EMITIENDO` vencido con número | A revisar  | Verificar con ARCA                     |
| `ERROR_CORREGIBLE`             | A revisar  | Corregir y reintentar                  |
| `RECONCILIAR`                  | A revisar  | Consultar ARCA; nunca reemitir directo |
| `APROBADO`                     | Emitidas   | Ver/descargar                          |
| `CANCELADO`                    | Historial  | Ver                                    |
| `BLOQUEADO`                    | A revisar  | Resolución administrativa              |

Cada fila muestra tipo Factura/NC/ND, venta, fecha comercial y fiscal, cliente, receptor si existe,
emisor/sucursal, total, cobrado, saldo, estado, validez `PRODUCCION/HOMOLOGACION/SIMULADA`, urgencia
y número fiscal. Hay conteos por pestaña y filtros por fechas, sucursal, emisor, documento y estado.

El icono actual de `/ventas` deja de emitir con sólo `venta_id`: abre este diálogo o enlaza a la cola.

### 7.5 Resultado parcial

Si la venta quedó registrada pero ARCA no terminó:

> La venta V-123 quedó registrada. No repitas la venta ni el cobro recién enviado. El saldo
> pendiente puede cobrarse normalmente. La factura quedó a revisar.

El mensaje incluye enlace a la venta/cola y distingue “venta no creada” de “venta creada, factura
fallida”.

## 8. Flujos del servidor

### 8.1 Registrar sin facturar

`crear_venta` debe, en la misma transacción que venta, pagos/deuda, caja y stock:

1. insertar la venta neutral;
2. establecer `afip_estado='SIN_FACTURAR'`;
3. no asignar receptor, fecha fiscal ni número;
4. en el fast-path de idempotencia, comprobar y reparar ese estado antes de retornar.

Si no puede dejar la venta en la cola, toda la creación hace rollback. ARCA queda fuera de la
transacción.

### 8.2 Registrar venta y facturar

1. El usuario completa el diálogo.
2. `crear_venta` registra una vez la venta ya marcada `SIN_FACTURAR`.
3. El motor reclama esa misma fila con token/lease.
4. Valida receptor, emisor, modalidad A, fecha, secuencia y montos.
5. Crea snapshot v2 y hash.
6. Reserva y persiste número antes de enviar.
7. Solicita CAE.
8. Persiste la respuesta bajo el mismo claim.

Si falla desde el paso 3, la venta permanece en cola. Nunca se repite `crear_venta` por un error
fiscal.

### 8.3 Facturar desde la cola

Reclama y emite la fila existente. No crea pagos, caja, stock ni otra venta. Reutiliza exactamente
el diálogo, preflight, claim, snapshot y motor del flujo inmediato.

### 8.4 Presupuestos

La conversión:

1. crea una sola venta neutral `SIN_FACTURAR` y retorna su `venta_id`;
2. opcionalmente abre el diálogo y emite exactamente ese ID;
3. si ARCA falla, el presupuesto queda `CONVERTIDO` y la venta/stock/caja/deuda permanecen;
4. deja de elegir A/B antes de conocer el receptor.

La experiencia de pagos mixtos/parciales debe reutilizar el cierre normal; no se agrega un segundo
motor de cobro.

### 8.5 Cobros posteriores

Se puede facturar una venta parcial o a cuenta corriente. Cobrar después sigue permitido en
`SIN_FACTURAR`, `ERROR_CORREGIBLE`, `RECONCILIAR` y `APROBADO`. El pago modifica sólo
`total_pagado`/saldo/caja/cuenta corriente; no toca snapshot, monto fiscal, fecha ni CAE.

## 9. Concurrencia, idempotencia y conciliación

- La creación comercial conserva su `idempotency_key`.
- Una fila de venta admite una sola emisión principal; su ID es la identidad natural.
- El claim fiscal es atómico por estado, versión, token y lease.
- Dos pestañas no pueden congelar receptores diferentes.
- Preflight, consulta remota y reserva se serializan por CUIT/PV/tipo —por lock transaccional o
  advisory lock—; un conflicto del índice único vuelve al preflight, no inventa otro número.
- La reserva se persiste antes de `FECAESolicitar`; las consultas SOAP de preflight ocurren antes.
- `REQUEST_INICIADO` se persiste inmediatamente antes de invocar `FECAESolicitar`; una caída desde
  esa fase se considera incierta.
- El timeout local no se interpreta como cancelación del request remoto.

Algoritmo mínimo ante falla:

1. timeout antes de reservar/enviar: liberar como error transitorio;
2. timeout después de enviar: `RECONCILIAR`;
3. consultar `FECompConsultar` y obtener los campos completos del comprobante;
4. comparar identidad de cabecera, documento, condición IVA del receptor, concepto, fecha, total,
   neto, exento, no gravado, desglose de alícuotas, IVA, tributos, moneda, cotización y asociados
   contra el snapshot;
5. si coincide exactamente, persistir ese CAE;
6. si ARCA confirma inexistencia y el último remoto es reservado−1, se puede reenviar el mismo
   número con el mismo payload;
7. cualquier salto, payload distinto o respuesta incompleta bloquea la secuencia y abre incidente;
8. nunca adjuntar un CAE comparando sólo CUIT/PV/tipo/ambiente.

La escritura final exige el mismo `claim_token` y exactamente una fila afectada. Una falla al
persistir después de recibir CAE no devuelve éxito al navegador: queda en conciliación.

## 10. Anulación, NC y ND

- `anular_venta` toma lock sobre la fila.
- `EMITIENDO` o `RECONCILIAR` bloquean la anulación hasta resolver ARCA.
- Sin CAE ni incertidumbre: cancela la intención y no crea nota fiscal.
- Con CAE de producción: crea atómicamente la venta-NC pendiente y sus efectos comerciales.
- NC/ND heredan snapshot de receptor, emisor, validez, ambiente y asociación original.
- La letra y el código de NC/ND derivan del `afip_cbte_tipo` original.
- No se elige otro receptor ni se relee el cliente vivo.
- `CbtesAsoc` congela tipo, PV, número y fecha del original.
- ARCA recibe importes positivos aunque la venta-NC comercial represente un ajuste negativo.
- Nunca se crea nota de producción contra homologación o simulación.
- El PV debe pertenecer al mismo emisor y ser compatible con el original.
- El total acumulado de NC `EMITIENDO`, `RECONCILIAR` y `APROBADO` no puede superar el original,
  bajo lock.
- Un original con `afip_legacy_incompleto=true` bloquea la NC automática hasta conciliación manual.
- Las ND mantienen las validaciones existentes y no alteran el receptor.

La nueva UI no agrega notas parciales libres; asegura el circuito actual de anulación y las notas ya
soportadas.

## 11. Impresión, QR y reportes

- PDF y QR nuevos usan exclusivamente snapshot v2.
- La fecha impresa es `afip_fecha_comprobante`, no `ventas.fecha`.
- Ventas, pagos y cuenta corriente siguen usando el cliente comercial.
- Cuando difieren, la pantalla muestra comprador y receptor; la factura imprime al receptor.
- A monotributista imprime la leyenda exacta vigente en factura, NC y ND.
- B/C a consumidor final imprime título del Régimen de Transparencia Fiscal, `IVA Contenido` y
  `Otros Impuestos Nacionales Indirectos`, cada uno con su importe correcto.
- Si existe CAE, generar QR es obligatorio. Un error de QR o snapshot bloquea la impresión fiscal.
- Se elimina el fallback que transforma una factura con CAE en documento interno.
- Los aprobados nuevos sin snapshot v2 son corrupción; sólo históricos con
  `afip_legacy_incompleto=true` pueden usar fallback de lectura.
- Un futuro Libro IVA deberá consumir snapshot; no forma parte de este rollout.

## 12. Factura A estándar y prueba ARCA

`FECompUltimoAutorizado(CbteTipo=1)` sólo prueba acceso a la secuencia tipo 1; no demuestra que la
modalidad administrativa del emisor sea A estándar.

Se agrega a cada emisor:

```text
DESCONOCIDA
ESTANDAR_CONFIRMADA
NO_SOPORTADA
```

- La confirmación es administrativa, por emisor, después de revisar ARCA/REAR con la contadora, y
  guarda `confirmada_at`, `confirmada_por` y fuente/evidencia.
- El panel pide revalidarla ante cambio de certificado, reclasificación informada por ARCA o revisión
  periódica definida; una evidencia vencida vuelve a `DESCONOCIDA`.
- A se bloquea mientras la modalidad sea `DESCONOCIDA` o `NO_SOPORTADA`.
- B puede operar aunque A esté pendiente de confirmar.
- La prueba informa por separado secuencia tipo 6 y secuencia tipo 1, sin llamarlas “A estándar
  verificada”.
- El motor sólo admite códigos estándar 1/2/3 para A y no intenta modalidades fuera de alcance.
- Nunca cambia silenciosamente A a B.

## 13. Seguridad y permisos

Se agrega `profiles.puede_facturar boolean NOT NULL DEFAULT false`, aplicado en servidor:

| Usuario                       | Operación                                                |
| ----------------------------- | -------------------------------------------------------- |
| Admin                         | Todas las sucursales, cola, conciliación y configuración |
| Empleado con capacidad fiscal | Emitir/reintentar en su sucursal activa                  |
| Empleado sin capacidad fiscal | Registrar sin facturar; no emitir                        |
| Cualquier empleado            | Sin acceso a claves/certificados ni configuración ARCA   |

No se deriva este permiso del acceso comercial a Ventas. Los admins lo tienen por rol; todos los
empleados empiezan en `false`. Antes de activar el feature flag se genera un listado de usuarios y el
admin habilita explícitamente a quienes deban emitir. Así no se amplían permisos fiscales por
accidente.

La seguridad no depende de ocultar botones:

- `/facturacion/cola` deja de ser `soloAdmin`: admite admin y empleado con capacidad fiscal;
- el empleado fiscal ve sólo su sucursal, puede emitir, corregir y reintentar rechazos definitivos;
- conciliación, liberación de claims y confirmación de ventas antiguas son sólo admin; el empleado
  ve esos casos como **Requiere administrador**;
- `/facturacion/configuracion`, emisores, PV y credenciales continúan `soloAdmin`;
- navegación y guards usan la misma capacidad que valida el servidor;

- funciones y server actions verifican `auth.uid()`, rol, capacidad y sucursal;
- `guard_profiles_privilegios` incorpora `puede_facturar`: un usuario no puede autoasignárselo al
  editar su propio perfil; sólo una acción admin de servidor puede cambiarlo;
- el emisor se deriva de la sucursal;
- se revoca el `UPDATE` directo de `ventas` a `authenticated`; las mutaciones comerciales y fiscales
  pasan por RPC específicas. RLS limita filas, pero no se usa como sustituto de permisos de columna;
- la función de transición fiscal es `SECURITY INVOKER`, sólo ejecutable por `service_role`, con
  firma exacta y sin grant a `PUBLIC`;
- funciones privilegiadas revocan `EXECUTE` de `PUBLIC` y otorgan sólo firmas explícitas;
- la tabla de intentos no tiene policies de navegador;
- favoritos expuestos tienen RLS de sucursal/usuario acorde al cliente;
- certificados, claves y tickets permanecen cifrados y sólo en servidor.

## 14. Migración y compatibilidad

### 14.1 Secuencia aditiva

1. Crear una migración separada para agregar `VENTA` al enum; no usar el valor nuevo en esa misma
   transacción.
2. Agregar campos, favoritos, intentos, índices, RLS y estados de compatibilidad.
3. Durante coexistencia, aceptar estados legacy `PENDIENTE/ERROR` y nuevos.
4. Desplegar lectores compatibles y escritores nuevos detrás de feature flag.
5. Adaptar `crear_venta`, conversión de presupuesto, anulación y cobro.
6. Desactivar el escritor fiscal viejo y mapear el delta bajo una ventana controlada.
7. Habilitar el flujo nuevo.
8. En una migración posterior, retirar estados legacy cuando no haya instancias/escrituras viejas.

Si cambia una firma RPC, se elimina la firma exacta anterior antes de crear la nueva; luego se
repiten `REVOKE/GRANT` sobre la firma exacta y se regeneran tipos Supabase. No se dejan overloads
ambiguos a PostgREST.

Índices mínimos:

- cola parcial `(sucursal_id, afip_estado, fecha DESC)`;
- documento normalizado de favoritos;
- `venta_id` en intentos;
- se conserva la unicidad fiscal exacta actual con emisor/PV/tipo/número/modo/simulación.

### 14.2 Backfill sin inventar historia

- `cae IS NOT NULL`: conservar estado autorizado y clasificar `afip_validez`; no convertir una
  simulación/homologación en producción.
- `afip_numero IS NOT NULL AND cae IS NULL`: `RECONCILIAR`.
- `afip_estado='ERROR'` sin número: `ERROR_CORREGIBLE`.
- factura A/B/C activa sin CAE ni número: `SIN_FACTURAR`.
- venta anulada sin CAE: `CANCELADO`.
- original con CAE permanece `APROBADO`; su NC es otra fila.
- remitos e internos: `NO_APLICA`.
- nota sin asociación fiscal válida: `BLOQUEADO`, visible en A revisar y sin emisión automática.

Snapshots v1 se preservan. Un histórico real sin snapshot completo conserva `APROBADO` y se marca
`afip_legacy_incompleto=true`; no se reconstruye CUIT/CUIL, receptor, PV ni fecha desde datos vivos.
El backfill nunca solicita CAE.

## 15. Pruebas obligatorias

### 15.1 Unitarias

- RI/monotributo → A; CF/exento → B;
- retiro de mono→B y del downgrade RI→B;
- CUIT 80, CUIL 86, CDI 87, DNI 96 y anónimo 99/0;
- umbral de CF debajo, igual y encima;
- snapshot canónico, orden estable y hash;
- fecha fiscal Córdoba y correlatividad;
- leyenda Ley 27.618;
- transparencia fiscal completa;
- allowlist fiscal;
- estados y permisos de edición.

### 15.2 SQL y servidor

- rollback completo si `crear_venta` no puede dejar `SIN_FACTURAR`;
- fast-path idempotente repara/asegura la cola;
- registrar sin facturar mueve venta/pago/deuda/stock una vez;
- facturar pendiente no repite ningún efecto;
- inmediato aprobado y rechazo conservando venta;
- parcial y cuenta corriente antes/después de emitir;
- timeout antes y después de reservar;
- `EMITIENDO` vencido con y sin número;
- doble submit y dos receptores concurrentes;
- persistencia fallida después del CAE;
- comprobante recuperado idéntico y payload divergente;
- cambio de emisor/configuración después de reservar;
- anulación bloqueada durante conciliación;
- CF comercial + receptor mono → A, deuda permanece en CF;
- RI comercial + receptor CF → B, deuda permanece en RI;
- one-off no crea cliente/favorito;
- favorito editado no cambia snapshot;
- NC/ND hereda receptor y NC acumulada no supera original;
- producción no se asocia a simulación/homologación;
- emisión fuera de orden por fecha se bloquea;
- A bloqueada hasta confirmación estándar y B disponible;
- General Paz sólo usa emisor APLI;
- presupuesto convierte una vez y usa la misma venta.

### 15.3 UI/E2E

- aparecen ambos cierres sólo en venta neutral;
- emisión inmediata y cola usan el mismo diálogo;
- registrar sin facturar no pide receptor;
- cliente/receptor y número de venta/factura se distinguen;
- letra derivada y combinaciones inválidas bloqueadas;
- total/cobrado/saldo visibles;
- checkbox de favorito;
- cola paginada, estados y acciones correctos;
- permisos con y sin capacidad fiscal;
- intento de autoasignarse `puede_facturar` rechazado en base;
- resultado parcial enlaza a la venta pendiente;
- QR/PDF muestran receptor y fecha congelados;
- homologación o simulación se rotulan inequívocamente y nunca parecen factura legal;
- fallo de QR bloquea impresión;
- teclado, foco, Escape y doble submit.

### 15.4 Regresión y verificación

- Vitest completa;
- typecheck;
- build Vercel;
- migraciones en base de prueba y tipos regenerados;
- advisors de Supabase;
- revisión adversarial fiscal, SQL y de concurrencia;
- ninguna prueba automática solicita un CAE real.

## 16. Rollout

1. Implementar por TDD en el worktree aislado.
2. Probar migraciones y backfill con copia representativa.
3. Aplicar migración aditiva.
4. Desplegar compatibilidad con feature flag apagado.
5. Verificar cola, permisos y lecturas sin emitir.
6. Cortar el escritor legacy, conciliar delta y activar el flujo.
7. Probar sólo consultas ARCA.
8. La primera factura real se emite manualmente con venta, receptor, letra, fecha y total confirmados.
9. Monitorear cola/conciliación antes de habilitar a más empleados.

## 17. Fuera de alcance

- modalidades especiales de A: **Pago en CBU informada** y **Operación sujeta a retención**;
- consulta automática obligatoria al padrón en el primer rollout;
- crear clientes comerciales desde un CUIT;
- mover deuda/pagos al receptor;
- facturación por lotes sin confirmación;
- editar identidad después de una reserva incierta;
- notas parciales libres nuevas;
- Libro IVA;
- emitir comprobantes reales en pruebas automáticas.

## 18. Criterios de aceptación

1. Toda venta neutral nace atómicamente en la cola fiscal.
2. Puede registrarse con o sin emisión inmediata.
3. La emisión inmediata y la cola permiten receptor distinto del comprador.
4. Facturar nunca repite venta, pago, deuda, caja ni stock.
5. A/B se deriva con la matriz vigente y A exige CUIT.
6. Pago parcial o posterior no cambia el comprobante.
7. Ningún reintento cambia payload ni duplica CAE.
8. Toda incertidumbre se concilia comparando el payload completo.
9. NC/ND hereda exactamente receptor y validez del original.
10. PDF/QR representan snapshot y fecha autorizados.
11. APLI sólo emite A cuando su modalidad estándar fue confirmada.
12. Backfill, migración, suite, typecheck y build terminan correctamente.

## 19. Fuentes oficiales verificadas

- Matriz A/B, leyenda a monotributistas y modalidades A:
  <https://www.arca.gob.ar/facturacion/regimen-general/comprobantes.asp>
- Manual WSFE y reglas de `CbteFch`:
  <https://www.arca.gob.ar/fe/ayuda/documentos/wsfev1-RG-4291.pdf>
- Transparencia fiscal:
  <https://biblioteca.arca.gob.ar/search/query/norma.aspx?p=t%3ARAG%7Cn%3A5614%7Co%3A9%7Ca%3A2024%7Cf%3A12%2F12%2F2024>
- Umbral de identificación de consumidor final vigente en 2026:
  <https://www.boletinoficial.gob.ar/detalleAviso/primera/338446/20260213>
