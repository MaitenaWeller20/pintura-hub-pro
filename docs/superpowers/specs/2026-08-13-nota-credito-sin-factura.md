# Nota de crédito sin factura asociada

**Pedido de Leo (12/08/2026):** _"Necesito que en las notas de crédito me deje guardar sin
tener que relacionarlo con alguna factura"._

> **v2** — reescrita después del review de Codex, que rechazó la v1. Lo que cambió está
> resumido en §8.

---

## 1. Qué pasa hoy

En `/ventas/nueva`, al elegir **Nota de crédito** aparece "Factura que rectifica \*"
obligatorio. Sin elegir una, Guardar queda gris. Y si el cliente no tiene ninguna factura
cargada en Quimex, la pantalla dice _"Este cliente no tiene facturas activas. Una nota
siempre rectifica una factura"_: callejón sin salida.

| Capa | Dónde | Qué hace |
| --- | --- | --- |
| UI | `ventas.nueva.tsx:521` | `canSave` incluye `(!esNota \|\| !!cbteAsocId)` |
| UI | `ventas.nueva.tsx:708` | El `Select` no ofrece opción vacía |
| RPC | `crear_venta` (migración `20260812120000:266-277`) | `RAISE EXCEPTION 'Una nota de crédito/débito tiene que indicar el comprobante que rectifica'` |

El zod (`ventas.functions.ts:75`) ya acepta `null`: no se toca.

## 2. El caso de uso REAL (uno solo)

**Devolución de mercadería cuya factura original no está en Quimex** — típicamente porque se
emitió en el sistema viejo (3C), que es exactamente la situación de hoy con la migración a
medio camino.

La v1 listaba también bonificaciones, descuentos comerciales y ajustes de saldo. **Están mal
como justificación y se sacan**: `crear_venta` repone stock por cada ítem de una
`NOTA_CREDITO` (migración `20260812120000:495-509`) y exige al menos un ítem con cantidad > 0
(`:389-391`). O sea que hoy el sistema **no puede expresar** una nota sin mercadería, ni con
factura ni sin ella. Una "bonificación" cargada así inflaría el inventario.

Que el sistema no tenga notas sin mercadería es una carencia real, pero es **otro** pedido:
va al backlog, no acá.

El caso que sí queda habilitado —devolución física— es coherente de punta a punta: entra
mercadería, se repone stock, se acredita el importe.

## 3. Qué exige AFIP

La pantalla afirma hoy: _"AFIP exige que toda nota indique el comprobante que corrige"_.
**Es incorrecto.** Según la **RG 4540/2019**, una NC/ND electrónica debe informar **o** el/los
comprobante(s) asociado(s) (`CbtesAsoc`) **o** el período asociado (`PeriodoAsoc`, desde/hasta)
— uno u otro, no los dos. Sin ninguno, AFIP no otorga CAE.

Verificado en el manual del desarrollador WSFEv1, la documentación de PyAfipWs sobre RG 4540/19
(`AgregarPeriodoComprobantesAsociados`) y pruebas de terceros en homologación.

**Consecuencia honesta:** el camino legal para rectificar una factura de 3C es `PeriodoAsoc`,
no omitir la emisión. Este cambio **no** lo implementa (ver §4), así que la pantalla tiene que
decir la verdad: lo que se guarda es un documento interno, no una rectificación fiscal.

## 4. Alcance

### Entra

Guardar una `NOTA_CREDITO` sin factura asociada. Queda como **nota interna**: repone stock y,
si va a cuenta corriente, acredita el saldo. **No se manda a AFIP.**

El estado ya existe y el sistema ya lo trata bien:

- `esNotaInterna(tipo, afip_cbte_asoc_id)` (`src/lib/fiscal/codigos.ts:50`) lo define.
- `anular_venta` ya genera notas así cuando el original no tenía CAE
  (`20260810130000:78`).
- El emisor las rechaza con un mensaje explicativo (`fiscal.functions.ts:337-341`).
- El PDF ya les agrega una leyenda de documento interno (`comprobante-pdf.ts:397-399`).

Falta sólo poder crear una **a mano**.

### No entra (y por qué)

**Emitir a AFIP con `PeriodoAsoc`.** Es el camino legal para una NC fiscal sin factura local.
No se hace ahora porque: (a) `arca.ts` no tiene el modelo — `DatosCae` sólo acepta
`comprobantesAsociados` (`arca.ts:35-48`) y sólo serializa `CbtesAsoc` (`arca.ts:246-252`);
(b) la facturación está en `MOCK` porque el certificado no salió, así que un cambio de payload
no se puede validar contra homologación. Mandar a producción un payload fiscal que nunca vio
homologación es peor que no mandarlo. **Va al backlog con la cita de la RG y esta ubicación.**

**`NOTA_DEBITO` sin factura.** La ND no tiene grilla: es un recargo calculado como porcentaje
del total de la factura que rectifica (`ventas.nueva.tsx:282-296`). Sin factura no hay base ni
letra heredada. Se mantiene la exigencia. (Si algún día se implementa `PeriodoAsoc`, esto hay
que revisarlo: una ND por intereses de un período es fiscalmente válida. No es una
imposibilidad conceptual, es una limitación del modelo actual.)

**Notas sin mercadería** (bonificaciones, ajustes de saldo). Ver §2.

## 5. Trampas que este cambio hace alcanzables, y cómo se cierran

Las tres las encontró el review. No las inventa este cambio —ya existen para las notas con
factura— pero al habilitar la creación manual pasan de teóricas a probables.

### 5.1 Una NC al contado sin pago no mueve plata

`crear_venta` sólo registra pago en caja si viene un pago (`:544-585`) y sólo acredita cuenta
corriente si `v_es_cta_cte` (`:587-589`). Y las notas están exceptuadas a propósito de la regla
"al contado se cobra algo" (`:452-456`). Resultado: una NC **CONTADO sin pago** repone stock
y baja el total de ventas del reporte, pero no le devuelve la plata al cliente ni le acredita
saldo. No queda en ningún lado — el mismo agujero que ya se cerró para las ventas el 29/07.

**Se cierra en la UI**: una NC exige o bien cuenta corriente (acredita saldo) o bien al menos
un pago (devuelve la plata), con el motivo escrito en pantalla.

**Por qué en la UI y no en la RPC:** la regla del servidor afectaría también a las notas
creadas por caminos que este cambio no toca, incluidas las automáticas de `anular_venta`
—que se insertan directas, sin pasar por `crear_venta`, pero cuyo criterio quedaría
inconsistente. Cambiar semántica de plata para flujos que no puedo probar contra el uso real
de la clienta es peor que el agujero. **Queda anotado en el backlog** como regla de servidor
pendiente.

### 5.2 Una NC interna creada a mano no se puede deshacer

`anular_venta` rechaza cualquier nota: `'Una % no se anula (las notas se corrigen con otra
nota)'` (`20260810130000:73-76`), y la UI ni siquiera ofrece el botón
(`ventas.index.tsx:209-212`). Corregir una NC equivocada requeriría una ND… que exige factura.
Círculo cerrado.

Hoy no molesta porque las únicas NC sin factura las genera el sistema. Con creación manual, un
error de carga queda grabado para siempre y con el stock ya inflado.

**Se cierra en la RPC**: `anular_venta` acepta anular una `NOTA_CREDITO` **sin CAE, sin
comprobante asociado y cargada a mano**. Es legítimo justamente porque nunca se declaró a
AFIP: no hay nada que rectificar con un documento compensatorio, alcanza con revertirla.
Revierte stock, cuenta corriente y caja, y la marca `ANULADA`. Una NC **con** CAE o **con**
factura asociada sigue sin poder anularse.

La tercera condición —"cargada a mano"— la encontró el review de la implementación y no es
obvia: anular un remito genera una nota interna que cumple las dos primeras, pero esa nota no
es un documento independiente, es la mitad de una anulación que **ya** devolvió el stock y
**ya** resolvió la plata. Revertirla dejaría la venta original en `ANULADA` con el stock
descontado de nuevo y la caja cobrando dos veces. Se reconocen porque el comprobante original
las apunta con `venta_anulada_por`, y quedan excluidas tanto en la RPC como en la UI.

**La caja tiene su propia trampa.** `venta_pagos` no tiene columna `estado` (a diferencia de
`proveedor_pagos`), así que `caja_esperado` sigue contando los pagos aunque la venta quede
`ANULADA`. Por eso la reversión **no** toca los pagos viejos —su sesión puede estar cerrada
desde ayer y el arqueo de ese día quedaría mal— sino que compensa con un `caja_movimientos`
de tipo `INGRESO` en la caja de hoy. Mismo patrón que `anular_compra`.

### 5.3 Carrera al cambiar de factura

`seleccionarFacturaRectifica` (`ventas.nueva.tsx:207-235`) consulta `venta_items` y después
hace `setItems`. Si se elige la factura A y antes de que responda se pasa a "sin factura"
(o se cambia de cliente o de tipo), la respuesta tardía repuebla la grilla con los ítems de A.
Los `useEffect` de limpieza (`:326-360`) no cancelan nada.

Hoy es difícil de provocar; con la opción "sin factura" pasa a ser un clic.

**Se cierra**: un token de pedido (`useRef` que se incrementa en cada llamada); el resultado
se aplica sólo si sigue siendo el último y la factura sigue seleccionada.

## 6. Cambios

### 6.1 Migración

**`crear_venta`** — reemplazar el bloque de notas:

```sql
IF p_tipo_comprobante IN ('NOTA_CREDITO', 'NOTA_DEBITO') THEN
  -- La ND es un recargo calculado como % del total de la factura: sin factura
  -- no hay base. La NC sí puede ir sola: queda como documento interno.
  IF p_tipo_comprobante = 'NOTA_DEBITO' AND p_cbte_asoc_id IS NULL THEN
    RAISE EXCEPTION 'Una nota de débito tiene que indicar la factura que recarga';
  END IF;
  -- Si se informa una, tiene que ser una factura de ESTE cliente: sin esto se
  -- podría acreditar contra la factura de otro.
  IF p_cbte_asoc_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ventas
     WHERE id = p_cbte_asoc_id AND cliente_id = v_cliente_id
       AND tipo_comprobante IN ('FACTURA_A', 'FACTURA_B', 'FACTURA_C')
  ) THEN
    RAISE EXCEPTION 'El comprobante a rectificar no existe o no es una factura de este cliente';
  END IF;
END IF;
```

**`anular_venta`** — permitir anular una nota interna (§5.2): aceptar `NOTA_CREDITO` cuando
`cae IS NULL AND afip_cbte_asoc_id IS NULL`, revirtiendo stock y cuenta corriente en vez de
emitir una nota compensatoria.

### 6.2 UI `src/routes/_authenticated/ventas.nueva.tsx`

1. `canSave`: sacar `(!esNota || !!cbteAsocId)` — la exigencia de la ND ya está en
   `:513-514`. Agregar la regla de §5.1 para la NC.
2. `Select`: opción explícita "Sin factura — queda como documento interno". Radix no admite
   `SelectItem value=""`: valor centinela mapeado a `""`.
3. Al pasar de una factura elegida a "sin factura": limpiar los ítems `desde_factura`
   (quedarían con precio histórico y sin asociación).
4. Token de pedido en `seleccionarFacturaRectifica` (§5.3).
5. Textos: el `*` sólo para ND; el aviso de "no tiene facturas activas" explica la salida en
   vez de cerrarla; y el texto de AFIP se corrige — en vez de afirmar algo falso, avisa la
   consecuencia real de guardar sin factura.

### 6.3 `docs/backlog.md`

Tres puntos nuevos: emisión con `PeriodoAsoc` (RG 4540/19), notas sin mercadería, y la regla
de servidor de §5.1.

## 7. Pruebas

- **Unitaria**: `esNotaInterna` con una NC manual sin asociación.
- **E2E**: guardar una NC sin factura; que la ND siga exigiéndola; que una NC con factura siga
  precargando productos.
- **Manual contra la base**: que la NC interna acredite cuenta corriente, reponga stock, y que
  anularla revierta las dos cosas.

## 8. Qué cambió respecto de la v1

| v1 decía | Realidad | v2 |
| --- | --- | --- |
| Sirve para bonificaciones y ajustes de saldo | La RPC exige ítems y repone stock siempre | Se saca; queda sólo devolución física |
| "Mueve stock, cuenta corriente y caja como cualquier nota" | Al contado sin pago no mueve ni caja ni cuenta | §5.1, con guarda en UI |
| No mencionaba la reversión | Una NC interna manual no se puede deshacer | §5.2, se habilita en `anular_venta` |
| No mencionaba la carrera | Respuesta tardía repuebla la grilla | §5.3, token de pedido |
| "AFIP acepta período, así que puede ser interna" | No se sigue: si corresponde rectificar algo fiscal, el camino es `PeriodoAsoc` | §3 y §4 lo dicen explícito |

Se revisó y **se descartó** un hallazgo del review: que un crédito de cuenta corriente quedaría
invisible para un cliente sin `condicion_cta_cte`. La vista vigente
(`20260718140000_seguridad_bajas_g6.sql:81-82`) tiene
`HAVING (c.condicion_cta_cte AND c.activo) OR saldo <> 0`, así que cualquier saldo distinto de
cero se ve. El review citó la definición original, reemplazada por esa migración.
