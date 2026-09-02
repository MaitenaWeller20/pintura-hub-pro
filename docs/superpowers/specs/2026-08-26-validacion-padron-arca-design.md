# Validación obligatoria de receptores por padrón de ARCA

- **Fecha:** 2026-08-26
- **Estado:** aprobado
- **Proyecto:** PinturaGest / Quimex
- **Servicio ARCA:** `ws_sr_constancia_inscripcion`

## 1. Objetivo

Evitar que una factura identificada se emita con una razón social inventada, desactualizada o
correspondiente a otro CUIT.

Todo receptor nuevo con CUIT se consultará en el padrón de ARCA. La identidad fiscal devuelta por
ARCA será la fuente autoritativa para el comprobante y se volverá a verificar en servidor antes de
solicitar el CAE. Si la consulta no puede completarse, la emisión queda bloqueada y no se intenta
obtener un CAE.

La regla se aplica a:

- el CUIT del cliente comercial;
- un receptor fiscal favorito con CUIT;
- un receptor manual con CUIT;
- facturas A y facturas B identificadas.

Los consumidores finales sin CUIT conservan el circuito actual. Las notas de crédito mantienen el
receptor inmutable del comprobante original: no reemplazan su identidad histórica con datos vivos
del padrón.

## 2. Decisiones aprobadas

- Se usa el servicio vigente `ws_sr_constancia_inscripcion`; no se integra el servicio de alcance 5
  deprecado `ws_sr_padron_a5`.
- Se reutiliza el certificado X.509 actual del emisor. En producción hay que asociar ese certificado
  al nuevo servicio mediante el Administrador de Relaciones de Clave Fiscal.
- La integración es estricta para todo receptor con CUIT una vez activada por emisor y ambiente.
- No existe bypass operativo ni confirmación manual que permita emitir cuando el padrón falla.
- La razón social o el nombre y el domicilio fiscal provienen de ARCA y no son editables para ese
  comprobante.
- El servidor valida otra vez el CUIT inmediatamente antes del CAE; no confía en los datos enviados
  por el navegador.
- No se cachean contribuyentes en la primera versión. El ticket WSAA sí conserva el caché cifrado
  existente, separado por CUIT emisor, servicio y ambiente.
- No se guarda la respuesta SOAP ni una copia completa del padrón. El snapshot conserva sólo los
  campos fiscales necesarios y la fecha de verificación.
- La integración se despliega inicialmente inactiva. Una prueba real y autenticada habilita la
  validación por cada credencial/ambiente sin interrumpir la facturación durante la configuración.

## 3. Servicio y credenciales

ARCA identifica el servicio como `ws_sr_constancia_inscripcion`. El SDK instalado,
`@arcasdk/core@2.0.0`, ya expone `registerInscriptionProofService` y usa un ticket WSAA específico
para cada servicio.

`SupabaseTicketStorage` ya separa los tickets por:

- CUIT del emisor;
- nombre del servicio;
- producción u homologación.

Por lo tanto, no se genera otro certificado ni se crea otro almacén de credenciales. La nueva
relación en ARCA autoriza al certificado existente a pedir un ticket para el padrón.

La prueba administrativa no usa solamente `dummy`, porque eso no demuestra autorización. Consulta
el CUIT del propio emisor mediante `getTaxpayerDetails` y exige una respuesta válida y activa.

## 4. Arquitectura

### 4.1 Adaptador de padrón

Un módulo servidor aislado será responsable de:

1. construir el cliente ARCA con el certificado cifrado actual;
2. pedir un ticket para `ws_sr_constancia_inscripcion` mediante el almacenamiento compartido;
3. consultar un CUIT con timeout explícito;
4. validar estructuralmente la respuesta del SDK;
5. normalizar identidad, domicilio, estado e indicios de condición fiscal;
6. clasificar los fallos en códigos cerrados y seguros.

El módulo no importa componentes de interfaz, no abre un cliente Supabase por su cuenta y no recibe
credenciales desde el navegador. Sus dependencias se inyectan para poder probar el comportamiento
real sin llamar a ARCA en la suite automatizada.

### 4.2 Resultado canónico

La salida interna tendrá una forma cerrada equivalente a:

```ts
type ReceptorPadronArca = {
  cuit: string;
  razonSocial: string;
  domicilioFiscal: string | null;
  estado: "ACTIVO";
  tipoPersona: "FISICA" | "JURIDICA";
  condicionIvaConfirmada:
    | "RESPONSABLE_INSCRIPTO"
    | "MONOTRIBUTO"
    | null;
  verificadoArcaAt: string;
};
```

Para una persona jurídica se usa `razonSocial`. Para una persona física, cuando no exista razón
social, se compone una denominación estable a partir de apellido y nombre. Se rechazan respuestas
sin CUIT coincidente, sin identidad utilizable, con estado distinto de `ACTIVO` o con estructuras
inesperadas.

No se decide una condición impositiva sólo por ausencia de datos:

- `MONOTRIBUTO` se confirma únicamente con evidencia explícita del bloque de monotributo vigente;
- `RESPONSABLE_INSCRIPTO` se confirma únicamente con una inscripción explícita en IVA;
- la ausencia de ambas no se transforma automáticamente en Exento o Consumidor Final.

Para Factura A, la condición debe poder confirmarse como Responsable Inscripto o Monotributista y
debe ser compatible con las reglas vigentes del motor. Para Factura B identificada, la identidad y
el estado activo son obligatorios. Si ARCA confirma Responsable Inscripto o Monotributo, esa
condición reemplaza cualquier declaración manual y el motor vuelve a determinar la letra; una B
solicitada que resulte incompatible se bloquea antes del CAE. Si ARCA no permite confirmar una
condición, no se inventa una por descarte y la condición declarada para la B continúa sujeta a la
validación final de WSFE.

### 4.3 Integración con el receptor existente

`resolverReceptorFiscal` incorpora una dependencia `consultarPadron` y deja de tomar como verdad la
razón social guardada cuando el documento confirmado es un CUIT.

- **Cliente comercial:** sólo se considera CUIT cuando `cuitValido` confirma los once dígitos y su
  dígito verificador. No se infiere el tipo documental por longitud.
- **Favorito:** conserva el CUIT y el ID como referencia operativa, pero nombre y domicilio del
  snapshot salen de la consulta actual.
- **Manual:** el operador ingresa el CUIT; nombre, domicilio y condición confirmable se completan
  desde ARCA.
- **Nota de crédito:** hereda exactamente el receptor del snapshot original aprobado.

El receptor confirmado tendrá `origen: "ARCA"`, `docTipoArca: 80`, el CUIT canónico como
`docNroArca` y `verificadoArcaAt` con el instante de la consulta.

No se actualizan automáticamente `clientes` ni `receptores_fiscales`. Corregir datos maestros puede
ofrecerse en otro cambio, pero no forma parte de esta integración.

### 4.4 Dos verificaciones con propósitos distintos

La interfaz consulta cuando dispone de un CUIT válido para mostrar al operador la identidad oficial.
Esa respuesta mejora la revisión, pero no autoriza por sí sola la emisión.

El servidor vuelve a consultar durante la preparación definitiva del comprobante, antes de reservar
identidad fiscal o ejecutar la solicitud de CAE. El snapshot se crea exclusivamente con esta segunda
respuesta.

No se agrega caché de personas. Un ticket WSAA válido puede reutilizarse, pero cada emisión obtiene
datos actuales del contribuyente.

## 5. Interfaz

### 5.1 Diálogo de emisión

Cuando el receptor tiene CUIT:

- se muestra `Consultando CUIT en ARCA…`;
- razón social/nombre y domicilio se completan desde el resultado;
- los campos oficiales quedan de sólo lectura;
- aparece el estado `CUIT verificado por ARCA` con la hora de consulta;
- cualquier cambio del CUIT invalida inmediatamente el resultado anterior;
- los botones de previsualizar y emitir permanecen deshabilitados mientras la consulta está en
  curso o falló.

El checkbox actual de confirmación manual no reemplaza la verificación de ARCA. Puede conservarse
para documentos no consultables, pero no habilita un CUIT fallido.

### 5.2 Configuración administrativa

Cada credencial y ambiente incorpora un estado separado para el padrón:

- `No configurado`;
- `Falta probar`;
- `Activo`;
- `Prueba fallida`.

La acción principal será **Probar y activar padrón**. Sólo administradores pueden ejecutarla. La
pantalla explicará el requisito externo: asociar el certificado actual al servicio
`ws_sr_constancia_inscripcion`.

Cambiar el certificado, la clave, el CUIT del emisor o el ambiente invalida la prueba y desactiva la
integración para esa credencial hasta repetirla.

## 6. Estado persistido y seguridad Supabase

Una migración aditiva amplía `credenciales_arca` con el mínimo estado operacional:

- `padron_probado_at timestamptz NULL`;
- `padron_validacion_activa boolean NOT NULL DEFAULT false`;
- `padron_ultimo_error_codigo text NULL`;
- `padron_ultimo_error_at timestamptz NULL`.

No se persiste el mensaje técnico ni la respuesta del contribuyente. Los campos públicos de
configuración exponen sólo estado y fechas; nunca certificado, clave, ticket o contenido SOAP.

La activación ocurre en servidor después de:

1. autorizar al usuario como administrador antes de abrir el cliente privilegiado;
2. cargar la credencial y el punto de venta del emisor/ambiente correctos;
3. consultar realmente el CUIT del emisor;
4. validar que la identidad esté activa y coincida;
5. actualizar prueba y activación en una sola operación lógica.

No se crea una tabla nueva expuesta a Data API. Se conservan las políticas y grants restrictivos de
`credenciales_arca`, y se actualizan los tipos generados de Supabase.

## 7. Errores de usuario

Los errores forman un catálogo cerrado. Ninguna pantalla muestra excepciones del SDK, SOAP, SQL,
red, certificados o tickets.

Los códigos públicos previstos son `PADRON_ARCA_CAIDO`, `PADRON_NO_AUTORIZADO`,
`PADRON_CONFIG_INVALIDA`, `CUIT_INVALIDO`, `CUIT_NO_ENCONTRADO`, `CUIT_INACTIVO`,
`RESPUESTA_PADRON_INVALIDA` y `CONDICION_FISCAL_INCOMPATIBLE`. La interfaz obtiene el texto desde
un único traductor compartido para que la previsualización y la emisión no presenten mensajes
distintos para el mismo código.

### 7.1 ARCA caído o timeout

Timeout, error de red, indisponibilidad HTTP o una falla transitoria del servicio se traducen a
`PADRON_ARCA_CAIDO`.

Mensaje aprobado:

> ARCA está caído y no pudimos verificar el CUIT. No se emitió ningún comprobante. Intentá
> nuevamente en otro momento.

No se usa la frase `ARCA no responde`.

### 7.2 Servicio no autorizado

> El certificado no está habilitado para consultar el padrón de ARCA. Un administrador debe
> asociarlo al servicio `ws_sr_constancia_inscripcion` y probar nuevamente la conexión.

### 7.3 CUIT inválido, inexistente o inactivo

Se distinguen:

- formato o dígito verificador inválido;
- CUIT inexistente en el padrón;
- CUIT inactivo;
- respuesta sin identidad suficiente;
- condición incompatible con Factura A.

Cada caso explica qué debe corregirse. Ninguno ofrece continuar manualmente con ese CUIT.

### 7.4 Registros técnicos

El servidor registra código estable, etapa, servicio, ambiente y duración. No registra token,
firma, certificado, clave privada, XML completo ni datos del padrón que no sean necesarios para
diagnosticar el código de fallo.

## 8. Semántica de fallo

La consulta obligatoria ocurre antes de reservar número o iniciar `FECAESolicitar`.

Ante cualquier error del padrón:

- no se solicita CAE;
- no se crea una identidad fiscal incierta;
- la venta comercial y sus pagos/stock no se duplican ni se revierten;
- la factura permanece pendiente y puede reintentarse en otro momento;
- el operador recibe un mensaje coherente y accionable.

Si ARCA autoriza el padrón pero luego WSFE falla, se conserva el tratamiento actual de errores de
emisión, conciliación y recuperación. La nueva consulta no altera las garantías anti duplicación.

## 9. Activación y despliegue

1. Aplicar la migración con `padron_validacion_activa=false`.
2. Desplegar servidor, configuración e interfaz sin cambiar todavía el flujo productivo.
3. En ARCA, asociar el certificado actual al servicio `ws_sr_constancia_inscripcion` para cada
   emisor que facture.
4. En Configuración, ejecutar **Probar y activar padrón** para homologación y/o producción según
   corresponda.
5. Confirmar una consulta real del CUIT del emisor.
6. Verificar una previsualización con CUIT de prueba autorizado.
7. Desde la activación, todo CUIT de ese emisor/ambiente queda en modo estricto y los operadores no
   tienen bypass.

El despliegue no activa automáticamente credenciales que no hayan superado la prueba. Esto evita
cortar Factura A durante el trámite externo en ARCA.

## 10. Pruebas

La implementación seguirá TDD. Cada comportamiento nuevo tendrá una prueba que falle antes del
código productivo.

### 10.1 Adaptador y normalización

- persona jurídica con razón social;
- persona física con apellido y nombre;
- domicilio fiscal completo o parcial;
- CUIT devuelto distinto;
- CUIT inexistente e inactivo;
- monotributo e IVA explícitos;
- condición ambigua sin inferencia por ausencia;
- respuesta incompleta, con arrays u objetos inesperados;
- timeout, caída de red y falta de autorización.

### 10.2 Receptor y emisión

- cliente comercial, favorito y manual con CUIT usan identidad ARCA;
- cambiar el CUIT invalida la consulta visual;
- una nota de crédito conserva el receptor original;
- Factura A exige condición confirmada compatible;
- Factura B identificada exige identidad activa;
- el snapshot usa `origen: "ARCA"` y una fecha válida;
- un fallo de padrón nunca invoca reserva ni solicitud de CAE;
- no se puede falsificar razón social modificando el payload del navegador.

### 10.3 Configuración, base e interfaz

- sólo un administrador puede probar y activar;
- una prueba fallida no activa;
- cambiar credencial, CUIT o ambiente invalida el estado;
- RLS/grants no exponen material sensible;
- todos los mensajes de usuario usan el catálogo cerrado;
- el diálogo marca los campos oficiales como sólo lectura y accesibles;
- pruebas de integración, concurrencia fiscal existente, typecheck y build completo.

## 11. Criterios de aceptación

- No se puede emitir una factura nueva a un CUIT sin consulta exitosa cuando la validación está
  activa para el emisor/ambiente.
- La razón social impresa coincide con la identidad devuelta por ARCA.
- Un operador no puede alterar esa identidad desde el navegador.
- ARCA caído bloquea antes del CAE y muestra exactamente el mensaje aprobado.
- La falta de autorización del servicio se diferencia de una caída de ARCA.
- Un CUIT inexistente o inactivo se explica sin mostrar errores técnicos.
- Factura A nunca usa una condición fiscal inferida por ausencia.
- Las notas de crédito siguen heredando el receptor original.
- La activación exige una prueba autenticada real y queda separada por emisor y ambiente.
- No se genera un certificado nuevo ni se exponen credenciales.
- La suite completa y las verificaciones SQL pasan antes del despliegue.

## 12. Fuera de alcance

- consultar DNI, CUIL o CDI como si fueran CUIT;
- modificar automáticamente clientes o favoritos con datos del padrón;
- guardar o exhibir la constancia completa de inscripción;
- cachear contribuyentes o permitir uso offline;
- reemplazar la validación final de WSFE;
- modificar comprobantes ya autorizados;
- habilitar un bypass manual o administrativo durante una caída.

## 13. Referencias oficiales

- [Catálogo de Web Services de ARCA](https://www.arca.gob.ar/ws/documentacion/catalogo.asp)
- [Manual de `ws_sr_constancia_inscripcion` v4.1](https://www.arca.gob.ar/ws/WSCI/manual_ws_sr_ws_constancia_inscripcion.pdf)
- [WSAA: autenticación, certificados y asociación a servicios](https://www.afip.gob.ar/ws/documentacion/wsaa.asp)
- [Certificados para producción](https://www.afip.gob.ar/ws/documentacion/certificados.asp)
