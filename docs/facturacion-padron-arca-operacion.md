# Operación del padrón de ARCA para receptores

**Actualizado:** 2026-08-26

**Alcance:** autorización, activación, operación ante fallas y vuelta atrás de la validación
obligatoria de receptores con CUIT.

> La migración y el despliegue dejan el padrón inactivo. Ninguna credencial queda habilitada hasta
> que un administrador completa la asociación externa y ejecuta una prueba real del CUIT propio para
> el emisor y el ambiente correctos.

## 1. Requisito externo

En el **Administrador de Relaciones de Clave Fiscal** de ARCA hay que asociar el certificado que ya
usa cada emisor al servicio exacto `ws_sr_constancia_inscripcion`. La relación de
**Facturación Electrónica (wsfe)** no concede acceso al padrón: son servicios distintos.

Se reutiliza el certificado existente. **No hay que generar otro certificado, CSR ni par de
claves** para esta integración. Antes de crear la relación, comprobar que están seleccionados el CUIT
representado, el alias del certificado y el ambiente que corresponden a esa credencial.

## 2. Por emisor y ambiente

La autorización y la activación se realizan por separado para cada combinación de emisor y
ambiente:

1. Asociar en ARCA el certificado de esa credencial a `ws_sr_constancia_inscripcion`.
2. En `/facturacion/configuracion`, abrir el emisor y el ambiente correctos.
3. Ejecutar **Probar y activar padrón**.
4. Confirmar que el estado de esa credencial cambie a **Activo**.

La prueba consulta realmente el CUIT del propio emisor mediante `getPersona_v2`; una prueba técnica
genérica no acredita la autorización. Homologación y producción se prueban y activan de manera
independiente. Si cambia el CUIT emisor, el certificado, la clave o el ambiente, la prueba anterior
se invalida y esa credencial vuelve a quedar inactiva.

## 3. Qué valida

Una vez activo para el emisor y el ambiente, el padrón valida todos los receptores con CUIT:

- el CUIT del cliente comercial;
- un receptor fiscal favorito con CUIT;
- un receptor manual con CUIT;
- facturas A y facturas B identificadas.

La razón social o el nombre, el domicilio fiscal y la condición que ARCA pueda confirmar salen de
la consulta vigente. El dato escrito o guardado no reemplaza la identidad devuelta por ARCA y la
consulta no modifica automáticamente el cliente ni el favorito.

El sistema no consulta DNI, CUIL ni CDI como si fueran CUIT. Una nota de crédito hereda el receptor
del comprobante original y no hace una consulta viva que pueda cambiar esa identidad histórica.

## 4. Caída de ARCA

Si el padrón está caído o la consulta obligatoria no puede completarse, la emisión se bloquea antes
de reservar número y antes de solicitar CAE. La factura queda pendiente para reintentar y no existe
un bypass por factura, operador o administrador.

El mensaje al operador es exactamente:

> ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá nuevamente en otro momento.

## 5. Diagnóstico seguro

Para diagnosticar una falla se registran únicamente:

- el código cerrado de error;
- la etapa de la operación;
- el servicio `ws_sr_constancia_inscripcion`;
- el ambiente, producción u homologación;
- la duración de la consulta.

No copiar ni adjuntar respuestas SOAP/XML, respuestas completas de personas, tickets WSAA,
certificados, claves privadas, firmas, mensajes crudos del SDK, stack traces ni secretos. El código
cerrado diferencia, entre otros casos, una caída, la falta de autorización del servicio, una
configuración inválida y un CUIT inexistente o inactivo sin exponer el detalle técnico.

## 6. Recovery

Ante una caída, esperar a que ARCA restablezca el servicio y reintentar **la misma factura
pendiente** desde el flujo fiscal correspondiente. No volver a crear la venta, no repetir ni volver
a cobrar su pago, y no facturarla por un circuito paralelo.

No desactivar la validación ni cambiar el receptor para atravesar la falla. Si ARCA ya está
operativo pero aparece una falta de autorización, un administrador debe corregir la relación externa
del certificado y volver a ejecutar **Probar y activar padrón** para esa credencial.

## 7. Rollout

El orden controlado es:

1. Revisar y aplicar la migración `20260826204629_padron_validacion_arca.sql` y desplegar la misma
   versión de la aplicación. La validación nace inactiva para todas las credenciales.
2. En ARCA, autorizar externamente `ws_sr_constancia_inscripcion` para el certificado existente de
   cada emisor y ambiente que se quiera habilitar.
3. Con un administrador autenticado, ejecutar la prueba real del CUIT propio mediante **Probar y
   activar padrón** para cada credencial.
4. En homologación, validar un receptor con CUIT autorizado y confirmar que la identidad oficial se
   muestre sin solicitar un comprobante de producción.
5. Recién con esa evidencia, autorizar y activar producción de forma controlada, emisor por emisor.

Aplicar la migración o desplegar el código no activa el padrón. Este documento tampoco autoriza una
migración remota, un despliegue, una activación ni la emisión de un CAE real.

## 8. Rollback

Ante un incidente de esta versión, detener el rollout y revertir el release completo mediante el
procedimiento de incidentes aprobado, preservando ventas, intentos, numeración, CAE y evidencia. La
vuelta atrás se coordina para aplicación y esquema; no se improvisan cambios parciales sobre datos
fiscales.

No ofrecer un bypass por factura a operadores ni administradores, no desactivar selectivamente la
validación para emitir durante la falla y no reemitir comprobantes inciertos. Si no puede garantizarse
el comportamiento estricto, mantener la facturación afectada en pausa hasta recuperar o revertir el
release bajo control.

Referencias oficiales:

- [Catálogo de Web Services de ARCA](https://www.arca.gob.ar/ws/documentacion/catalogo.asp)
- [Manual de `ws_sr_constancia_inscripcion` v4.1](https://www.arca.gob.ar/ws/WSCI/manual_ws_sr_ws_constancia_inscripcion.pdf)
- [WSAA: autenticación, certificados y asociación a servicios](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
- [Certificados para producción](https://www.afip.gob.ar/ws/documentacion/certificados.asp)
