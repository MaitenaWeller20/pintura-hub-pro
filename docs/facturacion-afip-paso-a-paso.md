# Facturación electrónica: puesta en marcha por empresa

**Actualizado:** 2026-08-19
**Alcance:** APLICACIONES Y SERVICIOS S.R.L. (General Paz) y GRUPO CASA FORMA S.A.S. (O'Higgins).

## 1. Regla principal

Cada persona jurídica se configura por separado:

| Local | Emisor | CUIT | Estado inicial |
|---|---|---|---|
| CasaForma General Paz | APLICACIONES Y SERVICIOS S.R.L. | 30-71419966-4 | PV 00005 de producción confirmado; CSR de producción generado |
| CasaForma O'Higgins | GRUPO CASA FORMA S.A.S. | 30-71732246-7 | PV 00001 de homologación inactivo; falta confirmar PV productivo y generar su CSR |

Cada CUIT tiene su propia clave privada, CSR, certificado, habilitación y numeración. Nunca hay que cargar el certificado de una empresa en la tarjeta de la otra.

Dos CUIT distintos pueden usar el mismo número de punto de venta sin conflicto. El número se repite sólo si ARCA efectivamente lo asignó a ambos; no se supone.

Producción y homologación también tienen credenciales separadas y pueden convivir. Para salir legalmente alcanza con preparar la credencial de **producción**.

## 2. Antes del trámite

En `/facturacion`, revisar la tarjeta de cada empresa:

- razón social y CUIT exactos;
- condición frente al IVA;
- domicilio fiscal;
- Ingresos Brutos;
- fecha de inicio de actividades;
- sucursal y número de punto de venta.

La fecha de inicio de actividades todavía debe confirmarse con la contadora. No se completa por aproximación porque queda impresa en el comprobante.

`ARCA_ENCRYPTION_KEY` no debe cambiarse: cifra las claves privadas. Si se pierde o se pisa, los certificados dejan de ser utilizables.

Mientras `INVOICING_MOCK_MODE=true`, el sistema no llama a ARCA, no registra una conexión como verificada y no permite habilitar credenciales reales.

## 3. CSR que recibe la contadora

En `/facturacion` → **ARCA por empresa** → tarjeta del CUIT correcto → **Producción**:

- Si ya existe una clave, aparece **Descargar CSR de producción**. Descargarlo de nuevo no rota ni reemplaza la clave privada.
- Si no existe, aparece **Generar CSR de producción**. El botón se habilita cuando el emisor tiene CUIT y razón social, y la sucursal tiene un PV productivo activo.

El archivo `.csr` sí se envía a la contadora. La clave privada nunca se descarga ni se manda: queda cifrada en el servidor.

Para General Paz se envía el CSR de APLICACIONES Y SERVICIOS S.R.L. Para O'Higgins se genera y envía otro CSR desde la tarjeta de GRUPO CASA FORMA S.A.S.

## 4. Pasos de la contadora en ARCA (producción)

Repetir todo el trámite con el CUIT representado correspondiente a cada empresa.

1. Entrar a ARCA con clave fiscal y seleccionar el CUIT de la sociedad.
2. Abrir **Administración de Certificados Digitales**.
3. Crear un alias identificable, por ejemplo `CasaForma-GeneralPaz` o `CasaForma-OHiggins`.
4. Subir el `.csr` correspondiente a ese CUIT.
5. Descargar el certificado emitido por ARCA (`.crt`, `.cer` o PEM).
6. En **Administrador de Relaciones de Clave Fiscal**, crear la relación entre ese certificado/alias y el Web Service de negocio **Facturación Electrónica (wsfe)**.
7. En **Administración de Puntos de Venta y Domicilios**, verificar o crear el PV para **RECE para aplicativo y web services**. No usar un PV de Comprobantes en Línea ni de Controlador Fiscal.
8. Informar para cada empresa: archivo del certificado, número de PV productivo, fecha de inicio de actividades y cualquier corrección de datos fiscales.

ARCA indica oficialmente que los certificados de producción se gestionan con Administración de Certificados Digitales, y que después deben asociarse al Web Service mediante Administrador de Relaciones. Véanse [Certificados](https://www.arca.gob.ar/ws/documentacion/certificados.asp) y [WSAA](https://www.arca.gob.ar/ws/documentacion/wsaa.asp).

## 5. De vuelta en el sistema

Para cada empresa:

1. Confirmar el número de PV y elegir **Producción (legal)**.
2. Activar **Sucursal habilitada para facturación electrónica** y guardar el PV.
3. En la credencial de producción, cargar el certificado devuelto por ARCA.
4. El sistema valida que el certificado corresponda a la clave privada de ese CSR. Si pertenece al otro CUIT o a otra clave, lo rechaza.
5. Apagar el modo simulado en el entorno desplegado (`INVOICING_MOCK_MODE=false`) y volver a desplegar.
6. Usar el botón de enchufe del PV para probar una conexión real.
7. Sólo después de una prueba real exitosa, presionar **Habilitar producción**.

Cambiar el número, ambiente o estado de un PV borra la verificación y deshabilita la credencial. Hay que probarla de nuevo; es intencional.

## 6. Orden recomendado para CasaForma

### General Paz

1. Confirmar fecha de inicio de actividades y demás datos fiscales.
2. Enviar a la contadora el CSR de producción ya generado.
3. Recibir y cargar el certificado de APLICACIONES Y SERVICIOS S.R.L.
4. Mantener PV 00005 en producción, salvo que ARCA muestre otro dato.
5. Probar conexión real y habilitar producción.

### O'Higgins

1. Confirmar fecha de inicio de actividades y demás datos fiscales.
2. Confirmar o crear en ARCA el PV productivo de GRUPO CASA FORMA S.A.S.
3. Cargar ese PV como producción, activarlo y guardarlo.
4. Generar el CSR de producción desde la tarjeta de O'Higgins y enviarlo a la contadora.
5. Recibir y cargar el certificado de GRUPO CASA FORMA S.A.S.
6. Probar conexión real y habilitar producción.

No hace falta que las dos empresas queden listas el mismo día: el sistema bloquea individualmente la que todavía no tenga credencial válida.

## 7. Primera factura real

Hacer una operación pequeña por cada CUIT habilitado y verificar:

1. que la venta muestre CAE y vencimiento;
2. que el CUIT emisor, PV y número sean los esperados;
3. que la numeración continúe desde el último comprobante autorizado de ese CUIT/PV/tipo;
4. que el comprobante aparezca en ARCA.

ARCA exige correlatividad dentro de cada punto de venta y que el PV usado para WSFE sea específico para ese sistema: [Solicitud de autorización](https://arca.gob.ar/fe/emision-autorizacion/solicitud-autorizacion.asp).

## 8. Diagnóstico rápido

| Mensaje o estado | Qué falta |
|---|---|
| `Falta generar CSR` | CUIT/razón social/PV activo del ambiente, o generar la clave |
| `Esperando certificado` | la contadora debe devolver el certificado de ese CSR |
| `Falta probar conexión` | apagar mock y ejecutar la prueba real con ese PV |
| `Lista, deshabilitada` | habilitar manualmente la credencial |
| `Bloqueada: PV inactivo` | confirmar, activar y guardar el PV de esa empresa |
| `Mock mode activo` | no hubo llamada a ARCA; no cuenta como prueba |
| `El certificado no corresponde a la clave privada` | se cargó otro certificado, posiblemente el del otro CUIT |
| `La nota no puede asociarse a un comprobante emitido por otro CUIT` | el comprobante original pertenece a la otra empresa |

La renovación de certificados es un flujo separado. No se borra ni rota una clave desde esta pantalla para evitar invalidar por accidente un certificado vigente.
