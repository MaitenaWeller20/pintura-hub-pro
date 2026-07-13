# Facturación electrónica — puesta en marcha

Guía para dejar a CasaForma facturando con validez legal ante AFIP (hoy ARCA).
No da nada por sabido. Seguila en orden.

**Dato importante para arrancar tranquilo:** el sistema ya funciona hoy, en
**modo simulado**. Se puede vender, cobrar, manejar stock y cuentas corrientes
desde el primer día. Lo único que falta es que las facturas tengan validez legal,
y eso es un trámite que se hace en paralelo. No hay que esperar a AFIP para
empezar a operar.

---

## Glosario mínimo

| Término | Qué es |
|---|---|
| **ARCA / AFIP** | La agencia de impuestos. Cambió de nombre pero todos le siguen diciendo AFIP. |
| **Punto de venta (PV)** | Un número que identifica desde dónde sale una factura. Cada sucursal necesita el suyo. Cada PV lleva su propia numeración. |
| **WSFE** | El sistema de AFIP que recibe facturas por API. El PV tiene que estar dado de alta específicamente como "Web Services - WSFE". |
| **CSR** | Un pedido de certificado. Lo genera el sistema, se sube a AFIP. |
| **Certificado (.crt)** | Lo que devuelve AFIP. Sirve para que AFIP sepa que quien factura es realmente CasaForma. |
| **Clave privada** | El complemento secreto del certificado. La genera el sistema y **nunca sale del servidor**. |
| **CAE** | El número de 14 dígitos con el que AFIP aprueba una factura. Sin CAE, la factura no vale. |
| **Homologación** | El servidor de pruebas de AFIP. Las facturas ahí son de mentira. |
| **Producción** | El servidor real. Las facturas cuentan para el fisco. |

---

## Qué se factura y qué no

El sistema maneja ocho tipos de comprobante, pero **solo cinco van a AFIP**:

| Comprobante | ¿Va a AFIP? | Para qué se usa |
|---|---|---|
| Factura A | ✅ Sí | Cliente Responsable Inscripto |
| Factura B | ✅ Sí | Consumidor final, monotributista, exento |
| Factura C | ✅ Sí | Solo si CasaForma fuera monotributista |
| Nota de Crédito | ✅ Sí | Anular o corregir una factura ya emitida |
| Nota de Débito | ✅ Sí | Agregar un cargo a una factura |
| **Remito interno** | ❌ No | Mover mercadería entre sucursales |
| **Remito de obra** | ❌ No | Mercadería que sale a una obra, a cuenta corriente |
| **Factura interna Cta Cte** | ❌ No | Documento interno de deuda del cliente |

Los tres últimos son **documentos internos**: mueven stock y generan deuda, pero
no son comprobantes fiscales. El sistema se niega a mandarlos a AFIP.

**La letra la elige el sistema solo**, según la condición de IVA del emisor y la
del cliente:

| CasaForma es | El cliente es | Sale |
|---|---|---|
| Responsable Inscripto | Responsable Inscripto | Factura **A** |
| Responsable Inscripto | Cualquier otro (o sin identificar) | Factura **B** |
| Monotributista | Cualquiera | Factura **C** |

⚠️ Para una **Factura A el cliente necesita el CUIT cargado**. Sin CUIT, AFIP la
rechaza. El sistema avisa antes de intentarlo.

---

## Etapa 1 — Cargar los datos (10 minutos, lo hacés vos)

Panel → **Facturación AFIP**.

Necesitás pedirle al cliente (o sacarlos de cualquier factura vieja que hayan
emitido):

- **CUIT** — 11 dígitos
- **Razón social** — el nombre legal exacto, no el de fantasía
- **Domicilio fiscal**
- **Condición de IVA** — Responsable Inscripto / Monotributo / Exento

> Si no tienen los datos a mano, pueden bajar la **Constancia de Inscripción**
> desde AFIP en 30 segundos, o mandarte una foto de una factura vieja.

Completá, dejá el toggle **"Facturación electrónica habilitada"** en ON, y guardá.

---

## Etapa 2 — Puntos de venta en AFIP (15 minutos, lo hace el contador)

**Cada sucursal necesita su propio punto de venta.** No se pueden compartir.

El contador entra a AFIP con clave fiscal nivel 3 y:

1. Busca el servicio **"Administración de puntos de venta y domicilios"**.
2. **A/B/M de puntos de venta** → **Agregar**.
3. Completa:
   - **Nombre de fantasía**: `CasaForma O'Higgins` (y después otro para General Paz)
   - **Sistema**: ⚠️ **"Web Services - Factura Electrónica - Bienes y Servicios - WSFE"**
   - **Domicilio**: el del local

> ⚠️ Si el contador elige "Factura en Línea" o "Controlador Fiscal" en vez de
> **WSFE**, no va a funcionar nada y el error de AFIP no lo va a decir claramente.
> Es el punto donde más se traba la gente.

Repetir para la segunda sucursal.

**Lo que te tiene que devolver:** los dos números que AFIP asignó. Los cargás en
el panel → Facturación AFIP → sección "Puntos de venta".

---

## Etapa 3 — El certificado (30-60 minutos, entre vos y el contador)

Es un ida y vuelta:

```
1. Vos generás el CSR en el panel
       ↓
2. Se lo mandás al contador
       ↓
3. El contador lo sube a AFIP → AFIP le devuelve un .crt
       ↓
4. El contador AUTORIZA ese .crt para el servicio WSFE   ← el paso que todos olvidan
       ↓
5. El contador te manda el .crt
       ↓
6. Vos lo pegás en el panel
```

**Tu parte (5 min):** Panel → Facturación AFIP → **"Generar CSR"**. Aparece un
texto largo. Copialo entero, con las líneas `-----BEGIN` y `-----END` incluidas.

> La clave privada se genera junto al CSR, se guarda **cifrada** en la base, y
> nunca sale del servidor. El CSR es público y no tiene ningún secreto.

**La parte del contador:** mandale el texto del [Anexo](#anexo--mail-para-el-contador).

**Cuando te devuelve el `.crt`:** abrilo con un editor de texto (arranca con
`-----BEGIN CERTIFICATE-----`), copiá todo, y pegalo en el panel → "Cargar
certificado".

El sistema **verifica que ese certificado corresponda a la clave que generamos**.
Si te equivocaste de archivo, te lo dice ahí mismo en vez de fallar después de
manera incomprensible.

---

## Etapa 4 — Probar en homologación (10 minutos)

1. En el panel, los puntos de venta tienen que estar en **Homologación**.
2. Apagá el modo simulado: variable de entorno `INVOICING_MOCK_MODE=false`.
3. Tocá el botón de **probar conexión** (el enchufe) al lado de un punto de venta.

| Respuesta | Qué significa |
|---|---|
| ✅ *"AFIP respondió. Último comprobante..."* | Todo bien. Seguí. |
| ❌ *Computador no autorizado* | Falta el **paso 4** de la Etapa 3: autorizar el certificado para WSFE. |
| ❌ *CUIT no autorizado* | El CUIT del panel no coincide con el del certificado. |
| ❌ *Certificado expirado* | Hay que renovarlo. |

Después: hacé una venta de prueba y emitila. Tiene que salir un CAE de 14 dígitos.

---

## Etapa 5 — Producción (lo hace el contador + vos)

⚠️ **Paso crítico que hace el contador:** habilitar cada punto de venta **para
producción** en AFIP ("Modalidad de emisión" → *Habilitado para producción - Web
Services*). Si no, AFIP rechaza todo con "punto de venta no autorizado".

Después, en el panel, cambiá cada punto de venta de **Homologación** a
**Producción**.

> Desde ese momento las facturas son legalmente válidas. No hay vuelta atrás:
> una factura con CAE no se borra, se corrige con una nota de crédito.

Hacé una factura real de prueba a tu propio CUIT y escaneá el QR del PDF: tiene
que abrir la página de AFIP con los datos.

---

## Uso diario

**Emitir:** en **Ventas**, cada comprobante fiscal sin CAE tiene un botón de
factura. Se toca y sale el CAE.

**Si AFIP no responde:** el comprobante queda en **PENDIENTE** y se puede
reintentar. El sistema es cuidadoso acá: si la primera llamada se cortó por
timeout, **antes de reintentar le pregunta a AFIP si igual la autorizó**, para no
emitir el mismo comprobante dos veces.

**Si AFIP rechaza:** queda en **ERROR** con el motivo. Se corrigen los datos y se
reintenta.

**Anular una factura:** desde el listado. El sistema genera la nota de crédito
automáticamente, la asocia a la factura original y devuelve el stock.

---

## Cosas que se rompen con el tiempo

**El certificado vence a los 2 años.** El panel avisa cuando faltan menos de 30
días. Cuando vence, **se corta la facturación**. Renovarlo es rehacer la Etapa 3.

**La clave de cifrado (`ARCA_ENCRYPTION_KEY`) no se rota nunca.** Si se pierde o
se cambia, el certificado guardado queda indescifrable y hay que rehacer todo el
trámite con AFIP. Guardala en un gestor de contraseñas.

**No mezclar homologación con producción.** Cada ambiente tiene su propia
numeración y su propio certificado. Si se mezclan, el sistema detecta que la
numeración quedó desincronizada y **se niega a emitir** en vez de duplicar
comprobantes — pero desenredarlo después es un dolor de cabeza.

---

## Anexo — Mail para el contador

```
Asunto: CasaForma — Setup de facturación electrónica

Hola,

Estamos poniendo en marcha el sistema de gestión de CasaForma (CUIT [CUIT]) y
necesitamos tu ayuda con dos trámites en AFIP. Si ya hiciste esto para otros
sistemas, te lleva 20 minutos.

═══════════════════════════════════════════════════════════════
TAREA 1 — Crear DOS puntos de venta (uno por sucursal)
═══════════════════════════════════════════════════════════════

1. Entrá a https://auth.afip.gob.ar con la clave fiscal.
2. Servicio "Administración de puntos de venta y domicilios".
3. "A/B/M de puntos de venta" → "Agregar".
4. Completá:
   - Nombre de fantasía: CasaForma O'Higgins
   - Sistema: ⚠️ "Web Services - Factura Electrónica - Bienes y
     Servicios - WSFE"
     (NO "Factura en Línea" ni "Controlador Fiscal" — el sistema
      necesita específicamente WSFE)
   - Domicilio: el del local
5. Repetí para la sucursal General Paz.

→ Mandanos los DOS NÚMEROS que te asignó AFIP.


═══════════════════════════════════════════════════════════════
TAREA 2 — Certificado digital
═══════════════════════════════════════════════════════════════

PARTE A — Generar el certificado

1. Servicio "Administración de Certificados Digitales".
2. "Agregar alias".
3. Completá:
   - Alias: casaforma
   - CSR: pegá EXACTAMENTE el texto de abajo, incluyendo las
     líneas -----BEGIN y -----END:

[ACÁ VA EL CSR]

4. Aceptar. Descargá el archivo .crt.


PARTE B — ⚠️ AUTORIZAR EL CERTIFICADO PARA WSFE

Este es el paso que más se olvida. Sin él, el certificado existe
pero no sirve para nada.

1. Volvé al menú de servicios.
2. "Administrador de Relaciones de Clave Fiscal".
3. "Nueva Relación".
4. Completá:
   - Servicio: Buscar → "WS Negocios - Web Services - Factura
     Electrónica - WSFE" → seleccionar.
   - Representante: Buscar → "Computador Fiscal" → seleccioná el
     alias "casaforma".
5. Confirmá.

→ Mandanos el ARCHIVO .crt de la Parte A.

═══════════════════════════════════════════════════════════════

Cualquier duda escribinos. Si te trabás en algún paso, mandanos
una captura.

Gracias!
```
