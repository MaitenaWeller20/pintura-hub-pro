# Venta y facturación con receptor fiscal

**Actualizado:** 2026-08-23  
**Uso:** operación diaria de ventas y cola fiscal.  
**Rutas:** `/ventas/nueva`, `/facturacion/cola` y, sólo para administración,
`/facturacion/configuracion`.

> Este circuito queda preparado detrás de banderas de activación. Este trabajo no habilita la v2,
> no migra producción y no autoriza un despliegue. Las migraciones de Supabase las ejecuta
> manualmente el responsable del proyecto.

## 1. Dos formas de cerrar una venta

### Registrar venta y facturar

1. Registra una sola vez la venta, el cobro o deuda, la caja y el movimiento de stock.
2. Abre la confirmación fiscal para elegir a quién se factura.
3. Intenta emitir en ese momento la factura de esa misma venta.

La factura siempre se emite por el total de la venta. Si se cobró sólo una parte, el saldo sigue
pendiente y puede cobrarse después sin cambiar ni duplicar la factura.

### Registrar sin facturar

Registra los mismos efectos comerciales —venta, cobro o deuda, caja y stock— pero no pide receptor
ni llama a ARCA. La venta queda en **Pendientes** en `/facturacion/cola` para facturarla después.

Facturar desde la cola no vuelve a vender, cobrar ni descontar stock: sólo emite el comprobante de
la venta ya registrada.

Quien no tenga permiso fiscal verá únicamente **Registrar sin facturar**. Un administrador debe
habilitar expresamente la capacidad de facturar para cada empleado.

## 2. Comprador/deudor y receptor fiscal

Son datos distintos:

- **Comprador/deudor:** el cliente de la venta. A él quedan asociados el cobro, el saldo y la cuenta
  corriente.
- **Receptor fiscal:** la persona o empresa cuyo documento y datos aparecen en la factura.

Se puede venderle a un cliente y facturar a otro CUIT/CUIL. Elegir otro receptor no cambia el
cliente comercial, la deuda, la caja, el stock ni los reportes de venta.

En el diálogo **Facturar a** se puede usar el cliente, un receptor guardado o cargar otro receptor.
Si se elige **Guardar para próximas facturas**, queda como ayuda de carga; no crea ni modifica al
cliente. Antes de emitir hay que revisar documento, razón social, condición de IVA y domicilio.

## 3. La letra A o B no se elige libremente

Para los emisores actuales, que son Responsables Inscriptos, el sistema calcula y vuelve a validar
la letra según la condición real del receptor:

| Condición del receptor | Letra |
|---|---|
| Responsable Inscripto | A |
| Monotributista | A |
| Exento | B |
| Consumidor final | B |

La factura A exige CUIT válido. No se permite bajar manualmente una operación que corresponde a A
a una factura B. Para consumidor final, el sistema aplica además las reglas vigentes de
identificación por importe.

Antes de emitir, el resumen muestra letra y motivo, receptor, emisor, CUIT, sucursal, punto de
venta, ambiente, fecha fiscal, total, cobrado y saldo. Si algo no coincide, cancelar y corregir; no
confirmar “para probar”.

### Requisito adicional para Factura A

Que ARCA responda la consulta de secuencia tipo 1 sólo demuestra acceso técnico. No confirma que el
emisor tenga habilitada la modalidad administrativa **Factura A estándar**.

Un administrador debe registrar en `/facturacion/configuracion`, para ese emisor, la fuente o
evidencia revisada con ARCA o la contadora y su fecha de revalidación. Mientras la evidencia esté
desconocida, vencida o indique que no está soportada, A queda bloqueada; B puede seguir operando.

## 4. Si la venta se creó pero la factura no salió

El sistema puede informar:

> La venta quedó registrada. No repitas la venta ni el cobro recién enviado. La factura quedó
> pendiente o a revisar.

Eso es un resultado parcial, no una venta fallida. La caja, el stock, el pago y la deuda ya quedaron
registrados. Abrir la venta o `/facturacion/cola` y continuar desde allí. **No volver a cargar la
venta, no volver a cobrar y no emitir otra factura a ciegas.**

## 5. Cola fiscal

En `/facturacion/cola` hay cuatro pestañas:

| Estado | Pestaña | Qué hacer |
|---|---|---|
| Sin facturar | Pendientes | **Facturar** y confirmar receptor y resumen |
| Emisión reciente | Pendientes | Esperar y refrescar; no repetir |
| Error corregible | A revisar | Corregir los datos y **Corregir/reintentar** |
| Resultado incierto o número reservado | A revisar | Administrador: **Verificar con ARCA** |
| Claim vencido sin número | A revisar | Administrador: liberar sólo después de verificar que no se envió |
| Bloqueado o incidente legado | A revisar | Resolución administrativa; no forzar emisión |
| Aprobado | Emitidas | **Ver/descargar** y controlar CAE |
| Cancelado | Historial | Consultar; no emitir |

Un empleado fiscal trabaja sólo con su sucursal. Los casos **Requiere administrador**, conciliación,
identidad dudosa, bloqueo o emisión vencida no se resuelven repitiendo el botón.

## 6. Venta demorada y fecha fiscal

La fecha comercial de la venta no se cambia. La fecha fiscal propuesta es la fecha real del intento
en Córdoba y respeta la última fecha autorizada de esa secuencia.

Si la venta tiene más de cinco días, el sistema muestra una advertencia. Revisar el caso con
administración o contabilidad y marcar **Confirmo emitir esta venta demorada con la fecha fiscal
informada** sólo si corresponde. No retrodatamos ni inventamos una fecha para que ARCA acepte.

## 7. Producción, homologación y simulación

- **Producción:** comprobante legal ante ARCA.
- **Homologación:** entorno de prueba de ARCA; no es un comprobante legal.
- **Simulada:** no hubo llamada a ARCA; cualquier CAE mostrado es de prueba y no tiene validez.

El resumen y la cola muestran el ambiente. Nunca entregar como factura legal un comprobante marcado
**Homologación** o **Simulada**.

## 8. Conciliación: nunca reemitir a ciegas

Ante `RECONCILIAR`, timeout posterior al envío o un número ya reservado:

1. No crear otra venta, no repetir el cobro y no usar una emisión manual paralela.
2. Un administrador abre **Verificar con ARCA** desde la cola.
3. El sistema consulta el mismo CUIT emisor, punto de venta, tipo y número.
4. Si ARCA ya autorizó, recupera y persiste ese CAE.
5. Si ARCA confirma que no existe, sólo entonces puede preparar el reenvío verificado con el mismo
   contenido fiscal.
6. Si hay diferencias de receptor, importe, fecha, secuencia o identidad, queda bloqueado para
   revisión administrativa.

Nunca borrar la fila ni cambiar receptor, importe, fecha, emisor o PV después de reservar un número.
Una nota de crédito o débito hereda el receptor y la identidad del comprobante original.

## 9. Puesta en marcha y vuelta atrás segura

El orden de activación exige un despliegue compatible, instancias anteriores drenadas, conciliación
de datos y autorización humana separada. Este documento no autoriza esos pasos ni la primera emisión
real.

Estado seguro previo al corte:

```text
facturacion_receptor_v2_enabled=false
facturacion_legacy_writer_enabled=true
```

Si durante una habilitación controlada hay que volver atrás, se usa la bandera prevista para frenar
el circuito nuevo y se conserva toda la evidencia para diagnóstico. **Nunca** reescribir historial
Git, borrar ventas o intentos, eliminar CAE, renumerar ni reemitir comprobantes a ciegas.

Antes de cualquier corte, registrar migraciones y checksums, valor de banderas, evidencia de A por
emisor, conteos de cola, pruebas y responsable de cada seguimiento. Las migraciones de Supabase son
manuales y sólo las aplica el usuario autorizado; no habilitar v2 ni desplegar desde esta tarea.
