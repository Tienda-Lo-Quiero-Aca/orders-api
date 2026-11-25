# Arquitectura y configuración

Cómo está armado el código, con qué servicios habla y cómo se configura.

← [Volver al inicio](../README.md)

**Contenido**

1. [Capas del código](#capas-del-código)
2. [Dónde está cada cosa](#dónde-está-cada-cosa)
3. [Integraciones](#integraciones)
4. [La carga de ventas](#la-carga-de-ventas)
5. [El seguimiento](#el-seguimiento)
6. [Crons](#crons)
7. [Variables de entorno](#variables-de-entorno)
8. [Sitio de documentación](#sitio-de-documentación)
9. [Tests](#tests)
10. [Limitaciones conocidas](#limitaciones-conocidas)

---

## Capas del código

NestJS 11 con arquitectura hexagonal. La lógica de la carga y del seguimiento no depende del framework ni de HTTP: vive en `src/core` y se prueba con mocks simples.

```
src/
├── core/                    Lógica de negocio, sin NestJS de por medio
│   ├── entitis/             Tipos de dominio y de cada API externa (sic: "entitis")
│   ├── adapters/            Interfaces de lo que el negocio necesita de afuera
│   ├── driver/repositories/ Implementaciones HTTP de esas interfaces
│   └── interactor/orders/   Casos de uso: carga, seguimiento, consultas
└── app/                     Todo lo que es NestJS
    ├── controllers/         Endpoints: validan la entrada y delegan
    ├── services/            Crons y una capa fina sobre las consultas
    ├── modules/             Módulos y providers: acá se cablea todo
    ├── guards/              Clave x-api-key
    └── drivers/docs/        Sitio de documentación en /docs
```

La dirección de las dependencias es siempre hacia adentro: `app` conoce a `core`, nunca al revés. Un interactor recibe sus repositorios por constructor, como interfaces (tokens `I_*`).

**Regla práctica:** si un cambio es sobre *qué* se carga o *cuándo* se bloquea, va en `core/interactor`. Si es sobre *cómo* se habla con un servicio externo, en `core/driver/repositories`. Si es sobre endpoints, crons o configuración, en `app`.

---

## Dónde está cada cosa

| Necesito cambiar… | Archivo |
|---|---|
| El recorrido de la carga, la ventana, el reintento | `core/interactor/orders/DispatchOrders.ts` |
| El seguimiento, el número TLQV, los 60 días | `core/interactor/orders/SyncOrderStatuses.ts` |
| Qué cuenta como entregada o cancelada | `core/interactor/orders/fravegaOrderLifecycle.ts` |
| Los campos que se mandan a VBI | `core/interactor/orders/mappers/toPowerAppsPayload.ts` |
| Cómo se lee una venta de Frávega (CUIL o DNI, avisos de datos incompletos) | `core/interactor/orders/mappers/fravegaFullOrderToNormalized.ts` |
| La tarjeta de Teams | `core/interactor/orders/mappers/toTeamsOrderPayload.ts` y `core/driver/repositories/notification/teams/TeamsNotificationRepository.ts` |
| Las consultas del panel | `core/interactor/orders/OrdersInteractor.ts` |
| Datos del comprador de Megatone | `core/interactor/orders/mappers/megatoneOrderEnrichment.ts` |
| La llamada a VBI | `core/driver/repositories/dispatch/powerapps/PowerAppsDispatchRepository.ts` |
| Lo que se guarda en Madre | `core/driver/repositories/madre-api/orders/mappers/toNormalizedOrderRequest.ts` |
| La corrección de hora de Seller Central | `core/driver/repositories/marketplace-api/fravega/orders/GetFravegaOrdersRepository.ts` |
| Un solo proceso a la vez | `core/interactor/orders/OrdersProcessLock.ts` |
| Crons y sus horarios por defecto | `app/services/orders/orders-cron.service.ts` |
| Qué endpoints piden clave | `app/guards/api-key.guard.ts` (`@Public()` en el controller) |
| Swagger, puerto, sitio de documentación | `main.ts` |
| Páginas publicadas y menú del sitio | `app/drivers/docs/docs-site.router.ts` |

---

## Integraciones

| Servicio | Para qué | Qué se llama |
|---|---|---|
| **marketplace-api** | Leer ventas de Frávega, Megatone y OnCity | `GET /fravega/full-orders` (carga), `GET /fravega/full-orders/:suborderId?orderid=` (seguimiento y reintento), `GET /fravega/vtex/orders` (consultas), `GET /megatone/orders`, `GET /oncity/orders` |
| **Madre** | Guardar las ventas y su estado | `POST /api/orders/batch` (de a 25), `GET /api/orders/:uniqueKey`, `GET /api/orders/pending` (de a 200), `PATCH /api/orders/:id/status` |
| **VBI** | Dar de alta la venta | `POST` a `POWERAPPS_API_URL` con `{ processId: "", data: {...} }` |
| **Teams** | Avisar cada venta nueva | `POST` a `TEAMS_WEBHOOK_URL` (flujo de Power Automate) con una tarjeta adaptativa |

| Servicio | Tiempo máximo de espera |
|---|---|
| marketplace-api y Madre | 90 segundos |
| VBI | 30 segundos |
| Teams | 10 segundos |

### Notas por integración

**marketplace-api** junta Seller Central y VTEX en una sola venta (`full-orders`). Si el detalle de Seller Central falla, la arma con el listado + VTEX y la devuelve con `source: "fallback"` y `missing: ["email"]`. Las ventas que no pudo armar vienen aparte, en `errors`. marketplace-api corre en su propio droplet y se deploya por separado.

**Madre** identifica cada venta por `unique_key` = `fravega:<suborderId>` (o `<marketplace>:<orderId>` si no hay suborden). Es lo que evita cargar dos veces la misma venta.

**VBI** responde `200` con `status` `success`, `duplicate` o `error`. `duplicate` quiere decir que ya tiene una venta con ese `NROVENTA`: cuenta como cargada y devuelve los datos de la existente. El servicio se apoya en eso para reintentar sin miedo a duplicar y para pedir el número TLQV. Cualquier otra respuesta es un error, y la respuesta completa queda en los registros (`[VBI] NROVENTA=… HTTP …`).

**Teams** se llama recién después de guardar en Madre. Si falla, solo se registra una advertencia (`[teams …] no se pudo notificar`): nunca cambia el resultado de la carga.

---

## La carga de ventas

`DispatchOrders.run()`, desde el cron o desde `POST /orders/fravega/sync`.

**Ventana.** Sin rango, arranca en la marca de la última carga automática completa (`lastSyncedUntil`) menos 30 minutos. La marca vive en memoria: después de un reinicio arranca 24 horas atrás. No es un problema porque Madre descarta las que ya tiene.

**La marca solo avanza** si la carga fue automática, el listado de Frávega se leyó completo y ninguna venta falló al guardarse en Madre. Si no, la próxima carga vuelve a cubrir el período.

**Hora de Seller Central.** Seller Central compara el filtro de fecha contra la hora argentina de la compra, ignorando la zona horaria. El repositorio le resta 3 horas al rango antes de pedirlo (`toSellerCentralDate`).

**Paginado.** Pide de a 50 ventas y sigue hasta la última página que informa Frávega (no corta por páginas incompletas, porque Frávega a veces devuelve menos de 50 aunque haya más). El tope es de 100 páginas.

**Orden de las operaciones.** Primero VBI, después Madre, en un único `POST /batch` con el resultado ya puesto. No hay un `PATCH` posterior que pueda fallar y dejar la venta a medias.

**Reintento.** `DispatchOrders.retry()` busca la venta en Madre, verifica que sea de Frávega y esté `FAILED`, vuelve a pedirla a marketplace-api y actualiza la fila existente con `PATCH /status`. Solo actualiza el estado, lo de VBI y los estados de Frávega: **no reescribe los datos del comprador** en Madre.

---

## El seguimiento

`SyncOrderStatuses.run()`, desde el cron o desde `POST /orders/fravega/status-sync`.

1. Lee todas las `PENDING` de Madre, de a 200 (tope: 50 páginas).
2. Descarta las que no son de Frávega o no tienen suborden (`ignored`) y las compradas hace más de `ORDERS_STATUS_MAX_AGE_DAYS` días (`tooOld`). Las que no tienen fecha de compra se revisan igual.
3. Revisa de a 5 en paralelo: pide cada una a marketplace-api y arma un único `PATCH` con lo que cambió (estado, cierre, número TLQV). Si no cambió nada, no llama a Madre.

**Un proceso a la vez.** La carga, el reintento y el seguimiento comparten un candado en memoria (`OrdersProcessLock`). Un segundo pedido recibe `409` y un cron que coincide se saltea.

---

## Crons

Se registran al iniciar el módulo (`OrdersCronService`) y no con `@Cron`, porque `main.ts` carga el `.env` después de que se evalúan los decoradores. Corren en hora de Argentina.

| Cron | Variable de horario | Por defecto | En producción (`k8s/config.yaml`) |
|---|---|---|---|
| Carga (`orders-sync`) | `ORDERS_SYNC_CRON` | `0 0 */2 * * *` (cada 2 horas) | `0 0 0,6,12,18 * * *` |
| Seguimiento (`orders-status-sync`) | `ORDERS_STATUS_CRON` | `0 30 * * * *` (cada hora a los :30) | `0 0 1,7,13,19 * * *` |

- La expresión lleva segundos: `seg min hora día mes díaSemana`.
- Si la expresión es inválida, se registra un error y se usa el horario por defecto: un valor mal escrito no tira el servicio.
- Un cron corre salvo que su variable `*_ENABLED` sea exactamente `false`. **Sin la variable, corre.**
- Al arrancar, el servicio registra cada cron con su horario (`[cron orders-sync] 0 0 0,6,12,18 * * * (America/Argentina/Buenos_Aires)`) o avisa que está deshabilitado.

---

## Variables de entorno

En local se leen de un `.env` en la raíz. El cargador es propio (`main.ts`): no pisa variables que ya existan y **no admite comentarios al final de una línea**, así que los comentarios van en su propia línea. En el cluster vienen del ConfigMap y del Secret (ver Operación).

### Variables del servicio

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `PORT` | No | `3000` | Puerto HTTP. |
| `API_KEY` | Sí, para los procesos | — | Clave del header `x-api-key`. Sin ella, los `POST` responden `500`. Se lee en cada pedido. |

### Variables de las integraciones

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `MARKETPLACE_API_BASE_URL` | **Sí** | — | URL de marketplace-api. Sin ella el servicio no arranca. |
| `MADRE_API_BASE_URL` | **Sí** | — | URL de Madre. Sin ella el servicio no arranca. |
| `POWERAPPS_API_URL` | Sí, para cargar | vacía | URL de VBI, con la clave `?code=...`. Vacía: toda venta queda `FAILED` con `POWERAPPS_API_URL no configurado`. Se lee al arrancar. |
| `TEAMS_WEBHOOK_URL` | No | vacía | URL del flujo de Power Automate, con la firma `&sig=...`. Vacía: no se avisa y todo lo demás sigue igual. Se lee en cada aviso. |

### Variables de los crons

| Variable | Por defecto | Para qué |
|---|---|---|
| `ORDERS_SYNC_CRON` | `0 0 */2 * * *` | Horario de la carga. |
| `ORDERS_SYNC_CRON_ENABLED` | corre | `false` la apaga. El endpoint manual sigue andando. |
| `ORDERS_STATUS_CRON` | `0 30 * * * *` | Horario del seguimiento. |
| `ORDERS_STATUS_CRON_ENABLED` | corre | `false` lo apaga. El endpoint manual sigue andando. |
| `ORDERS_STATUS_MAX_AGE_DAYS` | `60` | Días desde la compra en los que se sigue revisando una venta. Un valor que no sea un entero positivo registra un error y usa 60. |

### Variables del sitio de documentación

| Variable | Por defecto | Para qué |
|---|---|---|
| `DOCS_SITE_ENABLED` | `true` | `false` no publica el sitio. |
| `DOCS_SITE_PATH` | `/docs` | Dónde se publica. |
| `DOCS_SITE_USER`, `DOCS_SITE_PASSWORD` | vacías | Con las dos, el sitio pide usuario y clave y publica también la página de Operación. Sin ellas queda abierto y Operación no se publica. |

---

## Sitio de documentación

El servicio publica `README.md` y `docs/*.md` en `/docs` como un sitio con menú y buscador, armado con [Docsify](https://docsify.js.org). El navegador baja Docsify y Mermaid de jsDelivr; el servicio solo entrega el HTML y el markdown.

- **Las rutas del sitio copian las del repositorio** (README en la raíz, el resto en `docs/`), así los enlaces relativos entre los `.md` funcionan igual en el sitio y en GitHub.
- **Solo se sirven los archivos listados en `DOCS_PAGES`** (`docs-site.router.ts`). Nada más del repositorio se puede pedir por esta vía. Para agregar una página: crear el `.md` y sumarlo a la lista.
- **El markdown se lee del disco en cada visita.** En producción los archivos van dentro de la imagen (`Dockerfile`), así que un cambio de texto se publica con el deploy. El workflow también deploya cuando cambian `README.md` o `docs/`.
- **Los títulos no pueden empezar con un número.** Docsify le antepone `_` al id de esos títulos, y un enlace que funciona en GitHub deja de funcionar en el sitio. La numeración va en el índice de cada página.
- **Swagger está en `/api/docs`**, para no pisar el sitio.
- El sitio es middleware de Express: no pasa por el guard de `x-api-key`.

Vista previa local, sin levantar el resto del servicio:

```bash
npm run docs:preview                                         # abierto, sin Operación
DOCS_SITE_USER=tlq DOCS_SITE_PASSWORD=x npm run docs:preview # con clave, con Operación
```

`scripts/` está excluido de `tsconfig.build.json`: si se compilara, `nest build` dejaría la entrada en `dist/src/main.js` y el contenedor (que ejecuta `dist/main`) no arrancaría.

---

## Tests

```bash
npm test                    # todos
npx jest DispatchOrders     # uno por nombre
```

Los tests están junto al código (`*.spec.ts`). La cobertura fuerte está en `src/core`: la carga, el reintento, el seguimiento, el ciclo de vida de Frávega y los mappers de VBI, Teams y Madre. En `src/app` hay tests del guard, de los crons y del sitio de documentación.

---

## Limitaciones conocidas

**Solo se manda el primer producto.** Si una venta tiene más de un producto, VBI recibe solo el primero (`items[0]`).

**Varias subórdenes de una misma compra.** Madre separa por suborden, pero VBI identifica la venta por `NROVENTA`, que es el número de la compra. Si una compra llegara a tener dos subórdenes, la segunda volvería de VBI como `duplicate` de la primera y no se crearía. A revisar si Frávega empieza a partir compras.

**Las `FAILED` no se reintentan solas.** Las cargas las saltean porque ya están en Madre, y Madre solo expone `/pending`. Reintentarlas automáticamente necesita un endpoint en Madre que liste las `FAILED`.

**El reintento no completa los datos del comprador en Madre.** Una venta que falló en el origen se guardó sin datos del comprador, y el reintento solo actualiza el estado. VBI sí recibe los datos completos.

**Pensado para una sola réplica.** La marca de la última carga y el candado de "un proceso a la vez" viven en memoria. Con dos réplicas, cada una correría sus crons y sus cargas por separado. VBI y Madre evitan los duplicados, pero se duplicarían el trabajo y los avisos.

**Las consultas de Frávega salen de VTEX.** Traen el número de venta de VTEX (`FVG-…`), el estado en portugués y nada del comprador más que el nombre. El histórico puede tardar: lee hasta 5.000 ventas.

**`npx tsc --noEmit` marca dos errores** en specs (`TeamsNotificationRepository.spec.ts` y `OrdersInteractor.spec.ts`). Los tests corren igual porque ts-jest no frena por tipos.

**`test/app.e2e-spec.ts` es el ejemplo original de NestJS** (espera `GET /` → `Hello World!`) y fallaría: no hay tests end to end reales.
