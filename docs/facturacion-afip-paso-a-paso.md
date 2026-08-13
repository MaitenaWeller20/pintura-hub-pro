# Facturación electrónica: paso a paso para dejarla andando

**Actualizado:** 2026-08-04
**Para:** quien hace la configuración, con la clave fiscal del cliente en la mano.

---

## 0. Antes de tocar nada, leé esto

Tres cosas que, si las pasás por alto, hacen perder horas.

### 0.1 `INVOICING_MOCK_MODE` tiene que estar en `false`

Hay una variable de entorno en Vercel que hace que el sistema **invente el CAE**
en vez de pedírselo a AFIP. Existe para poder demostrar el circuito completo
mientras el trámite del certificado está en curso, y los comprobantes que emite
**no tienen ninguna validez legal**.

Está seteada en producción desde hace 20 días. Verificá su valor y, cuando vayas
a facturar de verdad:

```
vercel env ls production                 # ver que exista
vercel env rm INVOICING_MOCK_MODE production
vercel env add INVOICING_MOCK_MODE production     # y escribí: false
vercel --prod --yes                                # sin redeploy no toma efecto
```

Cómo darte cuenta de que está prendido: el botón de probar conexión responde
*"Mock mode activo: no se llamó a AFIP"*.

### 0.2 `ARCA_ENCRYPTION_KEY` no se toca nunca más

Con esa clave se cifra la clave privada del certificado. **Si cambia, el
certificado guardado queda ilegible y hay que rehacer todo el trámite con AFIP.**
Ya está configurada en producción. Si alguna vez hay que rotarla, se hace con
`ARCA_ENCRYPTION_KEY_PREVIOUS` (ver `src/lib/fiscal/crypto.ts`), no pisándola.

### 0.3 Un certificado por vez: homologación **o** producción

El sistema guarda **un solo** certificado. AFIP tiene dos mundos separados
(homologación y producción) con certificados distintos y que no se cruzan.

O sea: podés probar en homologación, pero para pasar a producción hay que
**borrar el certificado, generar un CSR nuevo y hacer el trámite de producción**.
No conviven.

Si tenés poco tiempo y el cliente ya factura con otro sistema, **saltéate
homologación y andá directo a producción** (§3). Homologación sirve para probar
sin riesgo, no es un requisito.

---

## 1. Lo que necesitás tener

- **CUIT** del cliente y **clave fiscal nivel 3** (o superior).
- Que ese usuario sea **Administrador de Relaciones** del CUIT, o que tenga
  delegado el servicio. Si al entrar no ves "Administrador de Relaciones de Clave
  Fiscal", no vas a poder hacer nada de esto: falta ese permiso.
- **Razón social exacta** como figura en AFIP.
- Acceso de **administrador** al sistema (la pantalla `/facturacion` es sólo
  admin).

---

## 2. En el sistema: datos del emisor y CSR

**El orden importa.** El CSR se arma con los datos del emisor, así que primero se
cargan y recién después se genera.

### 2.1 Cargar el emisor

`/facturacion` → **"1. Datos del emisor"**

| Campo | Qué va |
|---|---|
| CUIT * | sólo números, sin guiones |
| Condición de IVA * | Responsable Inscripto o Monotributo |
| Razón social * | **exacta** como figura en AFIP |
| Nombre de fantasía | opcional — es lo que va a ser el **alias** del certificado |
| Inicio de actividades | opcional |
| Domicilio fiscal | opcional |

Dejá el switch **"Facturación electrónica habilitada" apagado** por ahora. Se
prende al final, cuando esté todo probado.

Apretá **Guardar**.

### 2.2 Generar el CSR

`/facturacion` → **"3. Certificado digital"** → **Generar CSR**

Sale un bloque de texto que empieza con `-----BEGIN CERTIFICATE REQUEST-----`.
Copialo entero, lo vas a pegar en AFIP.

También te muestra el **alias**: es el nombre de fantasía (o la razón social si
no cargaste fantasía). Anotalo, en AFIP te lo va a pedir.

> ⚠️ **Generar un CSR nuevo invalida el certificado que ya esté cargado.** El
> sistema te frena si hay uno, y para forzarlo hay que borrarlo primero. Esto es
> a propósito: regenerar el CSR pisa la clave privada y deja el certificado
> viejo huérfano.

La clave privada **se queda en el sistema, cifrada**. No se descarga, no se
manda por mail, no existe fuera de ahí. Al de AFIP le das sólo el CSR, que es
público.

---

## 3. En ARCA (ex AFIP): el trámite

> Los nombres de los menús de ARCA cambian seguido desde el rebranding de 2025.
> Abajo va el nombre que tienen hoy y, entre paréntesis, cómo se llamaban antes,
> por si el portal te muestra otra cosa. **Lo que buscás por función** está en
> negrita.

Entrá a **arca.gob.ar** → *Iniciar sesión* → CUIT + clave fiscal.

### 3.1 Habilitar los dos servicios que vas a usar

En **"Administrador de Relaciones de Clave Fiscal"**:

1. **Adherir servicio** → AFIP/ARCA → Servicios Interactivos →
   **"Administración de Certificados Digitales"**.
2. **Adherir servicio** → **"Administración de Puntos de Venta y Domicilios"**.

Después de adherir un servicio hay que **cerrar sesión y volver a entrar** para
que aparezca en el menú. Es el paso que a todo el mundo se le pasa.

### 3.2 Crear el certificado

**"Administración de Certificados Digitales"** → *Agregar alias*

| Campo | Qué poner |
|---|---|
| Alias | el que te mostró el sistema (el nombre de fantasía) |
| Solicitud (CSR) | pegar / subir el CSR que copiaste en §2.2 |

Te devuelve un **certificado (.crt)**. Descargalo o copiá el texto — empieza con
`-----BEGIN CERTIFICATE-----`.

### 3.3 Autorizar el certificado a facturar

Esto es lo que más se olvida: tener el certificado **no** alcanza. Hay que
darle permiso a ese certificado para usar el servicio de facturación.

**"Administrador de Relaciones de Clave Fiscal"** → **Nueva Relación**

| Campo | Qué poner |
|---|---|
| Representado | el CUIT del cliente |
| Servicio | Buscar → AFIP/ARCA → **WebServices** → **"Facturación Electrónica"** (wsfe) |
| Representante | el **alias** del certificado que creaste en §3.2 |

Confirmá. Si el representante no aparece en la lista, es porque el certificado
todavía no se creó o estás mirando el CUIT equivocado.

### 3.4 El punto de venta

**"Administración de Puntos de Venta y Domicilios"**

#### Si ya hay un punto de venta creado

Entrá a la lista y fijate el **sistema** con el que está dado de alta. Tiene que
decir algo del estilo **"Factura Electrónica – Web Services"** o **"RECE para
aplicativo y web services"**.

- ✅ Si dice eso: anotá el número y listo, seguí en §4.
- ❌ Si dice **"Factura en Línea"**, **"Comprobantes en Línea"**, **"RCEL"** o
  **"Controlador Fiscal"**: **ese punto de venta no sirve** para este sistema. No
  se puede convertir: hay que dar de alta uno nuevo (abajo). El viejo lo podés
  dejar como está, conviven sin problema.

#### Si hay que crear uno nuevo

*Alta de punto de venta* (o "A/B/M de puntos de venta" → Alta):

| Campo | Qué poner |
|---|---|
| Número | el que sigue libre (si ya existe el 1, poné 2, 3…) |
| Nombre de fantasía | el del local |
| Sistema | **Factura Electrónica – Web Services** (WSFE / "RECE para aplicativo y web services") |
| Domicilio | el domicilio fiscal donde se emite |

El alta es **inmediata**: no hay que esperar aprobación.

> **Una sucursal, un punto de venta.** La base tiene un `UNIQUE` sobre
> `sucursal_id`, así que O'Higgins y General Paz necesitan **números
> distintos**. Si las dos usaran el mismo, la numeración de comprobantes se
> pisaría entre sucursales y AFIP rechazaría los que quedaran fuera de secuencia.

---

## 4. De vuelta en el sistema: cargar el certificado y el PV

### 4.1 Certificado

`/facturacion` → **"3. Certificado digital"** → pegar el `.crt` completo en el
cuadro → **Guardar certificado**.

El sistema **verifica que ese certificado corresponda a la clave privada que
generó** antes de aceptarlo. Si te equivocaste de archivo, o subiste el de
homologación teniendo la clave de producción, te lo rechaza en el momento con un
mensaje claro. Si lo aceptó, te muestra la fecha de vencimiento.

> Anotá esa fecha. Los certificados de AFIP duran **2 años** y cuando vencen la
> facturación se corta de golpe. El sistema no manda avisos.

### 4.2 Punto de venta

`/facturacion` → **"2. Puntos de venta"**

Hay una fila por sucursal. Poné el **número** que te dio AFIP y elegí el
**ambiente**:

- **Homologación (prueba)** → los comprobantes no valen legalmente.
- **Producción (legal)** → valen. La pantalla te lo avisa en rojo.

**Guardar**.

### 4.3 Probar la conexión

En esa misma fila hay un botón con un enchufe. Apretalo.

| Qué responde | Qué significa |
|---|---|
| *"AFIP respondió. Último comprobante tipo B autorizado en el PV N: X"* | ✅ anda todo |
| *"Mock mode activo: no se llamó a AFIP"* | falta apagar `INVOICING_MOCK_MODE` (§0.1) |
| Error de certificado / no autorizado | falta el paso §3.3, o el certificado es del otro ambiente |
| *"Esta sucursal no tiene punto de venta configurado"* | falta guardar el número en §4.2 |

Ese "último comprobante autorizado" también te sirve de control: si el cliente ya
venía facturando en ese punto de venta, **el número tiene que coincidir con el
último que emitió**. Si da 0 y debería dar 1500, estás mirando el PV equivocado.

### 4.4 Recién ahora, prender el switch

`/facturacion` → **"1. Datos del emisor"** → **"Facturación electrónica
habilitada"** → **Guardar**.

Con el switch apagado el sistema no emite nada, aunque esté todo lo demás
configurado.

---

## 5. La primera factura de verdad

Hacé **una sola** venta chica y facturala. Después verificá tres cosas:

1. Que la venta muestre **CAE y su vencimiento**.
2. Que el número de comprobante sea **el que sigue** al último que emitió el
   cliente.
3. Entrá a **"Comprobantes en línea"** en ARCA con la clave fiscal y confirmá que
   la factura figura ahí. Si no aparece, no existe para AFIP por más que el
   sistema muestre un CAE.

Ese tercer punto es el único que te dice de verdad que quedó bien.

---

## 6. Resumen del orden

```
  1. Sistema  → datos del emisor (switch APAGADO)          §2.1
  2. Sistema  → Generar CSR, copiarlo                      §2.2
  3. ARCA     → adherir los dos servicios + relogin        §3.1
  4. ARCA     → Certificados Digitales: alias + CSR → .crt §3.2
  5. ARCA     → Nueva Relación: wsfe ← alias               §3.3   ← el más olvidado
  6. ARCA     → punto de venta tipo WEB SERVICES           §3.4
  7. Sistema  → pegar el .crt                              §4.1
  8. Sistema  → número de PV + ambiente                    §4.2
  9. Sistema  → probar conexión                            §4.3
 10. Vercel   → INVOICING_MOCK_MODE=false + redeploy       §0.1
 11. Sistema  → prender el switch                          §4.4
 12.          → una factura de prueba y verificarla en ARCA §5
```

---

## 7. Errores frecuentes y qué significan

| Lo que ves | Qué pasó |
|---|---|
| "No hay certificado de AFIP cargado" | falta §4.1 |
| "La facturación electrónica está deshabilitada" | falta §4.4 |
| "Esta sucursal no tiene punto de venta configurado" | falta §4.2 |
| "No se pudo descifrar la clave privada. ¿Cambió ARCA_ENCRYPTION_KEY?" | alguien tocó la variable de entorno. Ver §0.2 |
| "Ya hay un certificado cargado…" al generar CSR | es el guard de §2.2. Borrá el certificado si querés renovar |
| "El certificado no corresponde a la clave privada" | subiste el .crt equivocado, o el del otro ambiente |
| Error SOAP raro / "no autorizado" al pedir CAE | casi siempre falta la relación del §3.3 |
| El CAE tiene 14 dígitos y empieza con muchos 7 | es un CAE **simulado**: mock mode sigue prendido |
| "El punto de venta no está autorizado" | el PV es de "Factura en Línea", no de Web Services (§3.4) |

---

## 8. Después de dejarlo andando

- **Anotá el vencimiento del certificado** (2 años) en algún lado con alarma. Es
  el fallo más molesto: un día deja de facturar y nadie sabe por qué.
- Los **puntos de venta de cada sucursal tienen que ser distintos**.
- Si alguna vez hay que rehacer el certificado: borrar → generar CSR → §3.2 →
  §3.3 → cargar. La relación con el servicio (§3.3) hay que rehacerla también,
  porque el alias nuevo es otro representante.
