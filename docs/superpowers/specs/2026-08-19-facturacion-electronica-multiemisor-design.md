# Facturación electrónica multiemisor

**Fecha:** 19/08/2026

**Estado:** diseño aprobado en conversación; pendiente de implementación

**Alcance:** separar identidad, credenciales y numeración de ARCA para las dos personas jurídicas que operan las sucursales.

## 1. Objetivo

Cada venta debe facturarse con el CUIT que corresponde a su sucursal:

| Sucursal | Emisor | CUIT | Situación inicial |
| --- | --- | --- | --- |
| CasaForma General Paz | APLICACIONES Y SERVICIOS S.R.L. | 30-71419966-4 | CSR ya generado; PV 00005 en producción |
| CasaForma O'Higgins | GRUPO CASA FORMA S.A.S. | 30-71732246-7 | Sin CSR/certificado productivo; PV pendiente de confirmar |

Un CSR identifica un CUIT, no una sucursal. El CSR existente sólo sirve para
Aplicaciones y Servicios. Grupo Casa Forma necesita otra clave privada, otro CSR,
otro certificado y su propia relación con el Web Service de Facturación
Electrónica en ARCA.

## 2. Estado y riesgos actuales

- `emisores` y `sucursales.emisor_id` ya representan correctamente las dos
  personas jurídicas.
- `fiscal_config` es un singleton: guarda un solo CUIT, una sola clave y un solo
  certificado. Hoy contiene la clave del CSR de Aplicaciones y Servicios.
- `generarCsr` genera una clave nueva aunque ya exista una sin certificado. Un
  segundo clic dejaría inutilizable el CSR que está tramitando la contadora.
- `cargarEmisorYPv` siempre lee el singleton, por lo que O'Higgins intentaría
  facturar con el CUIT de Aplicaciones y Servicios.
- `puntos_venta` tiene unicidad global por `(numero, modo)`. Dos CUIT distintos
  pueden usar legalmente el mismo número de PV.
- La numeración guardada en `ventas` tampoco incluye el emisor. Aunque se corrija
  `puntos_venta`, dos CUIT con el mismo PV/tipo/número chocarían en el índice de
  ventas y en la guarda del último comprobante local.
- Producción está segura mientras se realiza el cambio: facturación deshabilitada,
  modo simulado activo y cero CAE reales, simulados o pendientes.

## 3. Alternativas consideradas

### A. Mantener el singleton y habilitar sólo General Paz

Es el cambio más corto, pero deja O'Higgins fuera y obliga a rehacer todo después.
Además conserva el botón capaz de pisar la clave privada. Rechazada.

### B. Usar el mismo CSR/certificado en las dos sucursales

Sólo sería válido si ambas operaran bajo el mismo CUIT. No aplica: son dos
personas jurídicas diferentes. Rechazada.

### C. Credenciales y numeración por emisor

Una configuración fiscal por persona jurídica y ambiente, seleccionada a partir
de la sucursal de la venta. Es la opción elegida porque refleja el modelo legal y
permite activar General Paz sin habilitar O'Higgins.

## 4. Modelo de datos

### 4.1 Identidad fiscal en `emisores`

`emisores` pasa a ser la única fuente de identidad pública que se imprime y se
envía a ARCA. Se agrega `nombre_fantasia`; se completan CUIT, condición de IVA,
domicilio e Ingresos Brutos con los documentos recibidos.

No se inventará la fecha exacta de inicio de actividades. La fecha actualmente
cargada para Aplicaciones (`2013-10-01`) coincide con el alta de Ingresos Brutos,
pero todavía debe confirmarse que sea la fecha que corresponde imprimir para el
local/PV. El backfill fiscal dejará `inicio_actividades` en `NULL` en `emisores`;
el valor legado seguirá disponible en `fiscal_config` durante el rollback. Ambos
emisores permanecerán deshabilitados hasta completar el dato confirmado.

### 4.2 Nueva tabla `credenciales_arca`

Una fila por `(emisor_id, ambiente)`:

- `emisor_id`, FK a `emisores`.
- `ambiente`: `HOMOLOGACION` o `PRODUCCION`.
- `arca_key_enc` y `arca_cert_enc`, cifrados con el esquema AES-256-GCM actual.
- `cert_alias`, `cert_vence_at`.
- `habilitada`, inicialmente `false`.
- timestamps y restricción única `(emisor_id, ambiente)`.

La tabla tendrá RLS habilitado, sin políticas para `authenticated`, y permisos
sólo para `service_role`. El navegador recibirá únicamente estados booleanos y
fechas mediante funciones de servidor; nunca la clave o el certificado.

La fila productiva de Aplicaciones se crea copiando, sin descifrar ni regenerar,
la clave existente de `fiscal_config`. El singleton queda temporalmente como
respaldo de rollback, sin nuevas escrituras. Su eliminación será una migración
posterior, después de verificar el primer CAE real.

### 4.3 Puntos de venta

`puntos_venta` incorpora `emisor_id`. Se completa desde
`sucursales.emisor_id` y se exige consistencia con una FK compuesta:

`puntos_venta(sucursal_id, emisor_id)` → `sucursales(id, emisor_id)`.

Para soportarla, `sucursales` incorpora la restricción única auxiliar
`UNIQUE (id, emisor_id)`. El servidor deriva `emisor_id` desde la sucursal al
guardar el PV; no acepta que el navegador elija una combinación arbitraria.

Se mantiene una sola configuración de PV por sucursal y se reemplaza la unicidad
global por `UNIQUE (emisor_id, numero, modo)`. Así dos CUIT pueden tener, por
ejemplo, su propio PV 00005 sin mezclarse.

El PV 00005 productivo de General Paz se conserva. El PV 00001 de O'Higgins queda
inactivo y en homologación hasta que la contadora confirme o cree el PV correcto
para Web Services de Grupo Casa Forma.

### 4.4 Numeración fiscal en `ventas`

Se agrega `afip_emisor_cuit`, inmutable una vez reservado el número. Todo
comprobante con `afip_numero` debe tener también este CUIT.

La guarda de columnas fiscales de `ventas` incluirá el nuevo campo para impedir
que un cliente autenticado lo modifique directamente.

El índice fiscal pasa a cubrir:

`(afip_emisor_cuit, afip_punto_venta, afip_cbte_tipo, afip_numero, afip_modo, afip_simulado)`.

Las consultas de último número local y todas las guardas de numeración filtrarán
también por `afip_emisor_cuit`. Esto separa completamente las secuencias de los
dos contribuyentes.

Los datos históricos se completan primero desde `afip_snapshot` y, sólo como
fallback para filas antiguas, desde el CUIT legado. En producción actualmente no
hay CAE que migrar, pero la migración debe funcionar también en bases locales con
comprobantes simulados.

`afip_ta` no cambia: su clave primaria ya contiene CUIT, servicio y ambiente.

## 5. Flujo del servidor

La resolución autoritativa será:

`venta → sucursal → emisor → punto de venta → credencial del mismo ambiente`.

`cargarEmisorYPv` debe fallar cerrado si:

- la sucursal no tiene emisor;
- el PV no pertenece al mismo emisor;
- faltan CUIT, condición de IVA o fecha de inicio;
- el PV está inactivo;
- no existe la credencial para el ambiente del PV;
- la credencial está deshabilitada o no tiene clave/certificado.

La identidad impresa sale de `emisores` y se congela en `afip_snapshot` al emitir.
El snapshot también incorpora el teléfono de la sucursal. Ninguna reimpresión con
CAE relee datos actuales.

## 6. CSR y certificados

Las operaciones reciben siempre `emisor_id` y `ambiente`.

- **Primera generación:** si no hay clave, crea el par RSA y devuelve el CSR.
- **Volver a descargar:** si ya hay clave pero no certificado, genera nuevamente
  un CSR con esa misma clave. Nunca la reemplaza silenciosamente.
- **Certificado recibido:** valida firma, vigencia y correspondencia con la clave
  privada antes de guardarlo.
- **Credencial activa:** no se permite regenerar/reemplazar la clave desde el
  flujo normal. La renovación tendrá una acción explícita separada; no forma
  parte de esta primera activación.

El CSR existente de Aplicaciones sigue siendo válido porque su clave cifrada se
preserva. Cuando vuelva el `.crt`, la verificación clave↔certificado será la
prueba definitiva antes de almacenarlo.

## 7. Pantalla de Facturación

La pantalla muestra una tarjeta por emisor, no un formulario global:

1. Identidad fiscal y estado de datos obligatorios.
2. Sucursales y puntos de venta de ese emisor.
3. Credenciales separadas por ambiente.
4. Acciones propias: generar/descargar CSR, cargar certificado, probar conexión y
   habilitar.

Estados mínimos visibles:

- faltan datos fiscales;
- falta generar CSR;
- esperando certificado;
- certificado cargado, falta probar;
- listo pero deshabilitado;
- habilitado en homologación o producción.

La tarjeta de Aplicaciones reconocerá la clave existente y no ofrecerá una acción
que la pise. La tarjeta de Grupo permitirá generar su CSR independiente cuando
estén confirmados sus datos y PV.

## 8. Seguridad y errores

- Todas las escrituras fiscales requieren administrador en el servidor.
- El cliente nunca elige el CUIT que firma una venta: sólo envía `venta_id`; el
  servidor resuelve la sucursal y su emisor.
- Los secretos no aparecen en vistas, respuestas, logs ni mensajes de error.
- Si hay una inconsistencia emisor/PV/credencial, se bloquea la emisión antes de
  reservar numeración o llamar a ARCA.
- La migración no activa facturación ni cambia `INVOICING_MOCK_MODE`.

## 9. Pruebas

- Migración: backfill de emisores, credencial existente y PV; invariantes de FK y
  unicidad por CUIT/emisor.
- CSR: dos emisores producen claves distintas; volver a descargar no cambia la
  clave; un certificado de otro emisor es rechazado.
- Resolución: General Paz usa Aplicaciones/PV 00005; O'Higgins no puede usar esa
  credencial y queda bloqueada sin la propia.
- Numeración: dos CUIT pueden tener el mismo PV/tipo/número sin colisionar; un
  duplicado dentro del mismo CUIT sí se rechaza.
- Snapshot: la factura conserva CUIT y datos del emisor aun si luego cambian.
- UI/E2E: tarjetas y botones separados, estados correctos y ninguna regeneración
  destructiva del CSR existente.

Las pruebas de comportamiento se escriben primero y deben fallar antes del cambio
de producción correspondiente.

## 10. Despliegue y activación

1. Aplicar migración y código manteniendo modo simulado y ambas credenciales
   deshabilitadas.
2. Verificar que la clave existente aparece bajo Aplicaciones y que O'Higgins no
   puede verla ni usarla.
3. Cargar el `.crt` devuelto por la contadora y confirmar que corresponde a la
   clave preservada.
4. Confirmar fecha de inicio de actividades y PV 00005.
5. Desactivar el modo simulado, redesplegar y probar la conexión de General Paz.
6. Habilitar sólo Aplicaciones y emitir un comprobante real controlado.
7. Repetir el trámite completo con un CSR nuevo para Grupo Casa Forma; O'Higgins
   continúa bloqueada hasta entonces.

No se elimina `fiscal_config`, no se activa O'Higgins y no se emite ningún CAE
real como parte de la implementación técnica.
