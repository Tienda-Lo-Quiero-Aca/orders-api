# Referencia de la API

Todos los endpoints del servicio, agrupados por tema.

← [Volver al inicio](../README.md)

**URL base de producción:** `https://order.api.loquieroaca.com`

Los ejemplos usan dos variables de entorno para no repetir la URL y la clave:

```bash
export ORDER_API_URL="https://order.api.loquieroaca.com"
export ORDER_API_KEY="..."
```

**Contenido**

| Grupo | Endpoints |
|---|---|
| [Consultas](#consultas) | Últimas 24 horas · Últimas 24, 48 o 72 horas · Histórico · Todos los marketplaces · Un marketplace |
| [Procesos de Frávega](#procesos-de-frávega) | Cargar ventas nuevas · Seguimiento de estados · Reintentar una venta |

### Convenciones

- **Clave** — las consultas (`GET`) no la piden. Los procesos (`POST /orders/fravega/*`) piden el header `x-api-key`. Sin clave o con una incorrecta responden `401 API key invalida o ausente`; si el servidor no tiene `API_KEY`, `500 API key no configurada en el servidor`.
- **Fechas** — ISO-8601. Lo más seguro es mandarlas en UTC con `Z`, por ejemplo `2026-11-12T00:00:00.000Z`. Las respuestas siempre vuelven en UTC.
- **Procesos** — responden `201` cuando terminan, aunque alguna venta haya fallado: el detalle va en el cuerpo. Mientras corre otro proceso responden `409 Ya hay un proceso de ordenes en curso`.
- **Errores** — el cuerpo tiene la forma de NestJS: `{ "message": "...", "error": "Bad Request", "statusCode": 400 }`.

---

## Consultas

Solo lectura: no cargan nada en VBI ni escriben en Madre. Son las que usa panel.market.

Las que juntan varios marketplaces **no fallan si uno no responde**: devuelven los otros y avisan en `errors`. Las ventas salen ordenadas de la más nueva a la más vieja, y las que no tienen fecha de compra no se incluyen.

### Ventas de las últimas 24 horas

```
GET /orders/overview/last-24-hours
```

Igual que [Ventas de las últimas 24, 48 o 72 horas](#ventas-de-las-últimas-24-48-o-72-horas) con `24`.

```bash
curl -s "$ORDER_API_URL/orders/overview/last-24-hours"
```

### Ventas de las últimas 24, 48 o 72 horas

```
GET /orders/overview/recent/:hours
```

| Parámetro | Dónde | Valores |
|---|---|---|
| `hours` | ruta | `24`, `48` o `72`. |

El período termina en el momento del llamado.

```bash
curl -s "$ORDER_API_URL/orders/overview/recent/72"
```

**Respuesta**

```json
{
  "range": { "from": "2026-11-10T00:00:00.000Z", "to": "2026-11-13T00:00:00.000Z" },
  "total": 2,
  "marketplaces": [
    { "marketplace": "fravega", "total": 2 },
    { "marketplace": "megatone", "total": 0 },
    { "marketplace": "oncity", "total": 0 }
  ],
  "items": [
    {
      "marketplace": "fravega",
      "orderId": "FVG-v95020273frvg-01",
      "suborderId": "v95020273frvg-01",
      "createdAt": "2026-11-12T19:28:13.000Z",
      "amount": 367247,
      "latestStatus": "Pronto para o manuseio",
      "customer": { "name": "…", "document": null, "phone": null, "email": null },
      "shipping": {
        "address": null,
        "city": null,
        "province": null,
        "zipCode": null,
        "estimatedDeliveryDate": "2026-12-03T19:28:32.000Z"
      },
      "items": [],
      "raw": { }
    }
  ],
  "errors": []
}
```

| Campo | Qué es |
|---|---|
| `range` | El período consultado. |
| `total` | Cantidad de ventas en `items`. |
| `marketplaces` | Cuántas ventas trajo cada marketplace que respondió. |
| `items` | Las ventas, normalizadas. `raw` trae la venta tal como vino del marketplace. |
| `errors` | Un elemento por marketplace que no respondió: `marketplace`, `statusCode`, `message` y `response`. |

Qué datos trae cada marketplace está en la [guía funcional](funcional.md#consultas-para-el-panel). En Frávega, `orderId` es el número de VTEX, no el que va a VBI.

**Errores**

| HTTP | Mensaje |
|---|---|
| `400` | `El parámetro hours solo admite 24, 48 o 72.` |
| `400` | `Validation failed (numeric string is expected)`, si `hours` no es un número. |

### Histórico

```
GET /orders/overview/historical
```

Todas las ventas desde el **1 de enero de 2026** hasta ahora. Misma respuesta que [Ventas de las últimas 24, 48 o 72 horas](#ventas-de-las-últimas-24-48-o-72-horas).

Es la consulta más pesada: de Frávega lee hasta 5.000 ventas de VTEX (50 páginas de 100). Puede tardar.

### Todos los marketplaces

```
GET /orders?from=...&to=...
```

| Parámetro | Dónde | Obligatorio | Descripción |
|---|---|---|---|
| `from` | query | Sí | Fecha de compra desde (incluida). Alias: `fechaDesde`. |
| `to` | query | Sí | Fecha de compra hasta (incluida). Alias: `fechaHasta`. |

Si se mandan los dos nombres, gana `fechaDesde` / `fechaHasta`. Misma respuesta que [Ventas de las últimas 24, 48 o 72 horas](#ventas-de-las-últimas-24-48-o-72-horas).

```bash
curl -s "$ORDER_API_URL/orders?from=2026-11-12T00:00:00.000Z&to=2026-11-13T00:00:00.000Z"
```

**Errores**

| HTTP | Mensaje |
|---|---|
| `400` | `Debes enviar fechaDesde/fechaHasta o from/to en formato ISO-8601.` |
| `400` | `Las fechas deben tener formato ISO-8601 válido.` |
| `400` | `La fecha inicial no puede ser mayor a la fecha final.` |

### Un marketplace

```
GET /orders/:marketplace?from=...&to=...
```

| Parámetro | Dónde | Valores |
|---|---|---|
| `marketplace` | ruta | `fravega`, `megatone` u `oncity`. |
| `from`, `to` | query | Igual que en [Todos los marketplaces](#todos-los-marketplaces). |

```bash
curl -s "$ORDER_API_URL/orders/megatone?from=2026-11-12T00:00:00.000Z&to=2026-11-13T00:00:00.000Z"
```

**Respuesta**

```json
{
  "marketplace": "megatone",
  "range": { "from": "2026-11-12T00:00:00.000Z", "to": "2026-11-13T00:00:00.000Z" },
  "total": 0,
  "items": []
}
```

A diferencia de las consultas que juntan marketplaces, **acá sí falla si el marketplace no responde**: devuelve `502` con lo que contestó marketplace-api.

```json
{
  "error": "No se pudieron obtener órdenes de megatone.",
  "marketplace": "megatone",
  "statusCode": 500,
  "message": "[MARKETPLACE GET] /megatone/orders",
  "response": "..."
}
```

Ojo: el código HTTP es `502`, pero el `statusCode` del cuerpo es el que devolvió marketplace-api.

**Errores**

| HTTP | Mensaje |
|---|---|
| `404` | `Marketplace "amazon" no soportado. Valores válidos: fravega, megatone, oncity` |
| `400` | Los mismos de [Todos los marketplaces](#todos-los-marketplaces). |
| `502` | `No se pudieron obtener órdenes de <marketplace>.` |

---

## Procesos de Frávega

Piden el header `x-api-key`. **Dan de alta ventas reales en VBI y escriben en Madre.** Corren uno a la vez.

### Cargar ventas nuevas

```
POST /orders/fravega/sync
POST /orders/fravega/sync?from=...&to=...
```

Lo mismo que hace el cron: trae las ventas nuevas de Frávega, las da de alta en VBI, las guarda en Madre y avisa en Teams. Las que ya están en Madre se saltean, así que se puede repetir sin duplicar. El recorrido completo está en la [guía funcional](funcional.md#la-carga-paso-a-paso).

| Parámetro | Dónde | Obligatorio | Descripción |
|---|---|---|---|
| `from` | query | No | Fecha de compra desde. |
| `to` | query | No | Fecha de compra hasta. |

- **Sin parámetros**, procesa las ventas desde la última carga, igual que el cron.
- **Con `from` y `to`**, reprocesa ese período. Sirve para recuperar un período que no se cargó. Una carga manual no cambia desde dónde arranca la siguiente carga automática.

Las fechas van en UTC. Seller Central filtra por la hora argentina de la compra, y el servicio ya corrige esa diferencia: no hace falta restar nada.

```bash
curl -s -X POST "$ORDER_API_URL/orders/fravega/sync" \
  -H "x-api-key: $ORDER_API_KEY"
```

```bash
curl -s -X POST "$ORDER_API_URL/orders/fravega/sync?from=2026-11-12T00:00:00.000Z&to=2026-11-13T00:00:00.000Z" \
  -H "x-api-key: $ORDER_API_KEY"
```

**Respuesta**

```json
{
  "window": { "from": "2026-11-12T08:30:00.034Z", "to": "2026-11-12T20:29:01.731Z" },
  "collected": 2,
  "dispatched": 0,
  "cancelled": 0,
  "skipped": 0,
  "failed": 2,
  "errors": [
    {
      "orderId": "20277852",
      "stage": "source",
      "message": "[SOURCE_ERROR] seller-central: [FRAVEGA GET] https://seller-center-api.fravega.com/api/v1/orders/v95020273frvg-01?orderid=20277852 → 500"
    },
    {
      "orderId": "20274935",
      "stage": "source",
      "message": "[SOURCE_ERROR] seller-central: [FRAVEGA GET] https://seller-center-api.fravega.com/api/v1/orders/v95013051frvg-01?orderid=20274935 → 500"
    }
  ]
}
```

| Campo | Qué es |
|---|---|
| `window` | El período de compras que se procesó. |
| `collected` | Ventas que trajo Frávega, incluidas las que no se pudieron leer. |
| `dispatched` | Dadas de alta en VBI. |
| `cancelled` | Ya canceladas: guardadas sin cargarse en VBI. |
| `skipped` | Ya estaban en Madre. |
| `failed` | No entraron, o no se pudieron guardar en Madre. |
| `errors` | Un elemento por problema: `orderId`, `stage` (`collect`, `source`, `powerapps` o `persist`) y `message`. Qué significa cada uno está en [Bloqueos](bloqueos.md). Un error `collect` (no se pudo leer el listado de Frávega) aparece acá pero no suma en `failed`. |

Este ejemplo es real: las dos ventas no entraron porque Seller Central no daba su detalle. Hoy esas ventas [entran sin email](bloqueos.md#datos-incompletos) en lugar de bloquearse.

Una venta que entró **sin datos** (por ejemplo, sin email) cuenta en `dispatched`, no en `errors`. Se ve en Teams.

**Errores**

| HTTP | Mensaje |
|---|---|
| `400` | `Enviar from y to juntos, en formato ISO-8601.` |
| `400` | `from debe ser anterior a to.` |
| `409` | `Ya hay un proceso de ordenes en curso` |

### Seguimiento de estados

```
POST /orders/fravega/status-sync
```

Lo mismo que hace el cron de seguimiento: revisa las ventas `PENDING` de Frávega en Madre, cierra las entregadas y las canceladas, actualiza los estados que cambiaron y completa el número TLQV. Ver la [guía funcional](funcional.md#seguimiento-hasta-la-entrega).

```bash
curl -s -X POST "$ORDER_API_URL/orders/fravega/status-sync" \
  -H "x-api-key: $ORDER_API_KEY"
```

**Respuesta**

```json
{
  "checked": 41,
  "delivered": 3,
  "cancelled": 1,
  "open": 37,
  "tlqtFilled": 2,
  "ignored": 0,
  "tooOld": 5,
  "errors": []
}
```

| Campo | Qué es |
|---|---|
| `checked` | Ventas que se pudieron leer en Frávega. |
| `delivered` | Entregadas: pasaron a `COMPLETED`. |
| `cancelled` | Canceladas o devueltas: pasaron a `CANCELLED`. |
| `open` | Siguen en curso. |
| `tlqtFilled` | A cuántas se les completó el número TLQV. |
| `ignored` | `PENDING` de otros marketplaces, o sin número de suborden: no se siguen. |
| `tooOld` | Compradas hace más de `ORDERS_STATUS_MAX_AGE_DAYS` días (60): no se revisan. |
| `errors` | Un elemento por venta con problema: `uniqueKey` y `message`. |

**Errores**

| HTTP | Mensaje |
|---|---|
| `409` | `Ya hay un proceso de ordenes en curso` |

### Reintentar una venta

```
POST /orders/fravega/retry/:suborderId
```

Vuelve a pedir a Frávega una venta `FAILED` y repite la carga. Ver la [guía funcional](funcional.md#reintentar-una-venta).

| Parámetro | Dónde | Descripción |
|---|---|---|
| `suborderId` | ruta | Número de suborden de Frávega. Ej: `v95020273frvg-01`. En Madre es la parte de `unique_key` después de `fravega:`. |

```bash
curl -s -X POST "$ORDER_API_URL/orders/fravega/retry/v95020273frvg-01" \
  -H "x-api-key: $ORDER_API_KEY"
```

**Respuesta**

```json
{
  "uniqueKey": "fravega:v95020273frvg-01",
  "persistence_status": "PENDING",
  "last_error": null
}
```

Responde `201` también si la venta vuelve a fallar: en ese caso `persistence_status` es `FAILED` y `last_error` trae el motivo nuevo.

**Errores**

| HTTP | Mensaje |
|---|---|
| `404` | `No existe la orden fravega:v95020273frvg-01 en madre` |
| `400` | `Solo se reintentan ordenes FAILED (estado actual: PENDING)` |
| `400` | `El reintento solo esta disponible para ordenes de fravega` |
| `409` | `Ya hay un proceso de ordenes en curso` |
