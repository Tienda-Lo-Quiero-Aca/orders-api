# Guía funcional

Cómo llega una venta de Frávega a VBI, explicado desde la operación: de dónde sale cada dato, qué se carga, cómo se sigue la venta y qué se avisa.

← [Volver al inicio](../README.md)

**Contenido**

1. [Los dos trabajos del servicio](#los-dos-trabajos-del-servicio)
2. [De dónde salen los datos de una venta](#de-dónde-salen-los-datos-de-una-venta)
3. [La carga, paso a paso](#la-carga-paso-a-paso)
4. [Qué se carga en VBI](#qué-se-carga-en-vbi)
5. [Estados de una venta](#estados-de-una-venta)
6. [Seguimiento hasta la entrega](#seguimiento-hasta-la-entrega)
7. [El número TLQV](#el-número-tlqv)
8. [Avisos en Teams](#avisos-en-teams)
9. [Reintentar una venta](#reintentar-una-venta)
10. [Consultas para el panel](#consultas-para-el-panel)

---

## Los dos trabajos del servicio

| Trabajo | Marketplaces | Qué hace |
|---|---|---|
| **Carga de ventas** | Solo Frávega | Da de alta en VBI cada venta nueva, la guarda en Madre y la sigue hasta que se entrega o se cancela. |
| **Consultas** | Frávega, Megatone y OnCity | Devuelve las ventas de un período para panel.market. No carga nada ni escribe en ningún lado. |

Las ventas de **Megatone y OnCity no se cargan en VBI**: este servicio solo las muestra.

---

## De dónde salen los datos de una venta

Frávega tiene dos sistemas, y cada uno aporta una parte de la venta:

| Dato | Seller Central | VTEX |
|---|---|---|
| Nombre, DNI y CUIL del comprador | ✅ | Solo nombre y DNI |
| **Email real del comprador** | ✅ (en el detalle de la venta) | ❌ Enmascarado (`…@ct.vtex.com.br`) |
| Teléfono | | ✅ |
| Dirección de entrega y quién recibe | ✅ | ✅ |
| Producto, con su ASIN de Amazon | | ✅ |
| Precio de los productos | ✅ | |
| Total cobrado y medio de pago | | ✅ |
| Estado de la venta y de la entrega | ✅ | ✅ (otro vocabulario) |

Las dos partes las junta **marketplace-api**, otro servicio, que es quien habla con Frávega. Este servicio recibe la venta ya armada.

### Cuando Seller Central no da el detalle

El detalle de una venta en Seller Central falla seguido (error 500), aunque el listado de ventas sí responda. En ese caso marketplace-api arma la venta con el **listado de Seller Central** (que trae el CUIL y el DNI) más **VTEX**. Lo único que se pierde es el **email**.

Esa venta se carga igual en VBI, con el email como `no-encontrado`. En Teams sale marcada como **con datos incompletos**.

Si fallan los dos sistemas, la venta no se puede leer y queda bloqueada (ver [Bloqueos](bloqueos.md#source_error)).

---

## La carga, paso a paso

En producción la carga corre sola a las **0, 6, 12 y 18 horas** (hora de Argentina). También se puede disparar a mano (ver [Referencia de la API](api.md#cargar-ventas-nuevas)).

1. **Qué ventas trae.** Las compradas desde la última carga completa, con 30 minutos de margen hacia atrás para no perder ninguna en el borde. Si el servicio se acaba de reiniciar, trae las de las últimas 24 horas.
2. **¿Ya está en Madre?** Si la venta ya fue cargada, en cualquier estado, se saltea. Así una venta nunca se carga dos veces, aunque entre en dos cargas seguidas.
3. **¿Se pudo leer?** Si Frávega no la devolvió, queda `FAILED` con el motivo `SOURCE_ERROR`.
4. **¿Está cancelada o devuelta?** Una venta cancelada no se da de alta en VBI: queda `CANCELLED`.
5. **Alta en VBI.** Se manda la venta a VBI. Si VBI la acepta, queda `PENDING`, o `COMPLETED` si Frávega ya la entregó. Si VBI la rechaza, queda `FAILED` con el motivo `VBI_ERROR`.
6. **Madre.** Recién ahí se guarda en Madre, con el estado y lo que respondió VBI.
7. **Teams.** Se avisa en el canal (ver [Avisos en Teams](#avisos-en-teams)).

**Ninguna venta se frena por datos del comprador.** Si falta el CUIL, el DNI o el email, se carga igual con lo que haya y lo que falte va como `no-encontrado`.

**Si una venta entró a VBI pero no se pudo guardar en Madre**, la próxima carga la vuelve a procesar. VBI reconoce que ya la tiene (por el número de venta) y no crea otra.

---

## Qué se carga en VBI

Cada venta se manda a VBI con estos campos:

| Campo en VBI | Qué lleva | Si falta |
|---|---|---|
| `NROVENTA` | Número de la compra en Frávega (Seller Central). Ej: `20277852`. | — |
| `FECHAVENTA` | Fecha de compra, en hora de Argentina (`dd/mm/aaaa`). | vacío |
| `FECHAENTREGA` | Fecha estimada de entrega (`dd/mm/aaaa`). | vacío |
| `SKU` | ASIN del producto. | vacío |
| `LINKAMAZON` | `https://www.amazon.com/dp/<ASIN>` | vacío |
| `NOMBREPRODUCTO` | Nombre del producto. | vacío |
| `Cantidad de Unidades` | Unidades del producto. | vacío |
| `PRECIOVENTA` | Precio de los productos, **sin el envío**. Si no está, el total cobrado. | vacío |
| `ESTADO` | Estado de la venta en Seller Central. Ej: `Created`. | vacío |
| `TIPOVENTA` | `FRAVEGA` | — |
| `CUITCOMPRADOR` | El CUIL o CUIT del comprador; si no lo hay, el DNI. | `no-encontrado` |
| `NOMBREDESTINATARIO` | Nombre del comprador. | vacío |
| `Datos Cliente` | Dirección de entrega y nombre de quien recibe. | vacío |
| `TELEFONO` | Teléfono del comprador. | vacío |
| `EMAIL` | Email real del comprador. | `no-encontrado` |
| `CIUDAD`, `PROVINCIA`, `CODIGO POSTAL` | De la dirección de entrega. | vacío |

Si la venta tiene **más de un producto, solo se manda el primero** (ver [Limitaciones conocidas](tecnico.md#limitaciones-conocidas)).

---

## Estados de una venta

El estado de cada venta en Madre (`persistence_status`) sigue lo que pasa con la venta en Frávega:

| Estado | Qué significa |
|---|---|
| `PENDING` | Está cargada en VBI y todavía no se entregó. |
| `COMPLETED` | Está cargada en VBI y Frávega ya la entregó. |
| `CANCELLED` | Frávega la canceló o el comprador la devolvió. Si se canceló antes de la carga, nunca se dio de alta en VBI. |
| `FAILED` | No entró a VBI. El motivo está en `last_error` (ver [Bloqueos](bloqueos.md)). |

Junto con el estado, Madre guarda lo que respondió VBI:

| Columna | Qué guarda |
|---|---|
| `notification_system_b_status` | `success` si VBI aceptó la venta, `failed` si la rechazó. |
| `floxu_code` | El número TLQV (ver [El número TLQV](#el-número-tlqv)). |
| `vbi_sale_id` | El identificador de la venta en VBI. |
| `vbi_nro_venta` | El número de venta que VBI registró. |
| `last_error` | El motivo de un `FAILED` o el detalle de un `CANCELLED`. Vacío si todo salió bien. |

---

## Seguimiento hasta la entrega

En producción, a las **1, 7, 13 y 19 horas** (una hora después de cada carga) el servicio revisa todas las ventas `PENDING` de Frávega:

| Si en Frávega… | La venta pasa a |
|---|---|
| Se entregó | `COMPLETED` |
| Se canceló o se devolvió | `CANCELLED`, con el detalle en `last_error`. Ej: `[CANCELLED] Seller Central: Canceled (entrega -), VTEX: canceled` |
| Sigue en curso | Queda `PENDING` |

Además, si cambió el estado de la venta o el de la entrega en Frávega, lo actualiza en Madre.

**Una devolución cuenta como cancelación.** Seller Central manda: si dice `Canceled` o `Returned`, la venta se cancela aunque VTEX no se haya enterado.

**Solo se revisan las compradas en los últimos 60 días.** Una devolución puede llegar hasta unas cinco semanas después de facturar, más la entrega y los diez días de arrepentimiento. Las más viejas quedan `PENDING` sin revisar.

El seguimiento **no avisa en Teams** los cambios de estado.

---

## El número TLQV

VBI le asigna a cada venta un número TLQV (por ejemplo `TLQV-22733`), pero lo hace **después** de crearla. Por eso, al darla de alta, casi siempre vuelve vacío.

El seguimiento lo completa solo: a cada venta `PENDING` que VBI aceptó y todavía no tiene número, la vuelve a mandar a VBI. VBI reconoce que ya la tiene, **no crea otra venta** y devuelve el número, que se guarda en `floxu_code`. No se hace con las ventas canceladas.

---

## Avisos en Teams

Cada venta nueva que se guarda en Madre se publica en un canal de Teams, con fecha, cliente, producto, monto y número TLQV si lo hay. El título de la tarjeta dice cómo entró:

| Título | Cuándo |
|---|---|
| **Nueva orden FRAVEGA #20277852 (PENDING)** | Entró bien a VBI. |
| ⚠️ **Nueva orden FRAVEGA #20277852 (PENDING) con datos incompletos** | Entró a VBI, pero sin algún dato (por ejemplo, sin email porque Seller Central no dio el detalle). La tarjeta trae una línea `Aviso:` con la explicación. |
| 🔴 **Orden FRAVEGA #20277852 NO entro a VBI (FAILED)** | No entró. La tarjeta trae el error y cómo reintentarla. |
| **Nueva orden FRAVEGA #20277852 (CANCELLED)** | Ya estaba cancelada: no se cargó en VBI. |

Al [reintentar una venta](#reintentar-una-venta) también se avisa, siempre que Frávega haya devuelto la venta: así se ve en el canal cuando entra una que había fallado.

El aviso no frena nada: si Teams no responde, la venta queda cargada igual y el problema solo se anota en los registros del servicio.

---

## Reintentar una venta

Una venta `FAILED` **no se reintenta sola**: las cargas siguientes la saltean porque ya está en Madre. Hay que reintentarla a mano con su número de suborden (ver [Referencia de la API](api.md#reintentar-una-venta)).

El reintento vuelve a pedir la venta a Frávega y repite la carga:

- Si VBI la acepta, pasa a `PENDING` (o `COMPLETED` si ya se entregó).
- Si mientras tanto se canceló, pasa a `CANCELLED` sin cargarse en VBI.
- Si vuelve a fallar, sigue `FAILED` con el motivo nuevo.

Solo se reintentan ventas de Frávega en estado `FAILED`. Una venta `PENDING` o `COMPLETED` ya está en VBI: reintentarla podría duplicarla, así que el servicio lo rechaza.

---

## Consultas para el panel

panel.market pide las ventas de un período (o de las últimas 24, 48 o 72 horas) y el servicio las junta de los tres marketplaces. Son de solo lectura.

Cada marketplace aporta datos distintos:

| Marketplace | De dónde | Qué trae |
|---|---|---|
| Frávega | Listado de VTEX | Número de venta en VTEX (`FVG-v95020273frvg-01`), fecha, total, estado **en portugués** (ej: `Pronto para o manuseio`), nombre del comprador y fecha estimada de entrega. |
| Megatone | marketplace-api | Número de orden, fecha, monto, último estado, y del comprador: nombre, CUIT o documento, teléfono, email y dirección. |
| OnCity | marketplace-api | Número de orden, fecha, monto, último estado y nombre del comprador. |

Dos diferencias con la carga a tener en cuenta:

- **En la consulta, Frávega se lee de VTEX**, no de Seller Central. Por eso el número de venta es el de VTEX y no el que va a VBI, y no trae CUIL ni email.
- **Si un marketplace no responde, la consulta no falla**: devuelve los otros dos y avisa en `errors` cuál faltó.

Las ventas salen ordenadas de la más nueva a la más vieja. Las que no tienen fecha de compra no se muestran.
