# Bloqueos

Motivos por los que una venta de Frávega no entra a VBI, o entra incompleta. Para cada uno: qué significa y qué hacer.

← [Volver al inicio](../README.md)

Una venta bloqueada queda en Madre en estado `FAILED`, con el motivo en `last_error` con este formato:

```
[MOTIVO] detalle
```

También sale en Teams con la tarjeta 🔴 y en la respuesta de la carga, en `errors`.

**Contenido**

- [Los más frecuentes](#los-más-frecuentes)
- [Motivos que dejan la venta FAILED](#motivos-que-dejan-la-venta-failed)
- [Ventas que no son un error](#ventas-que-no-son-un-error)
- [Problemas que no llegan a Madre](#problemas-que-no-llegan-a-madre)
- [Problemas del seguimiento](#problemas-del-seguimiento)
- [Cuáles se reintentan solos](#cuáles-se-reintentan-solos)

---

## Los más frecuentes

| Motivo | En una línea | Qué hacer |
|---|---|---|
| [`SOURCE_ERROR`](#source_error) | Frávega no devolvió la venta. | Reintentarla cuando Frávega responda. |
| [`VBI_ERROR`](#vbi_error) | VBI rechazó la venta o no respondió. | Leer el detalle y reintentarla. |
| [Datos incompletos](#datos-incompletos) | Entró a VBI sin email u otro dato. | Completar el dato en VBI si hace falta. |
| [`CANCELLED`](#cancelled) | La venta ya estaba cancelada. | Nada: no se carga. |

---

## Motivos que dejan la venta FAILED

### `SOURCE_ERROR`

marketplace-api no pudo armar la venta: fallaron VTEX y el detalle de Seller Central, o falló VTEX solo. El detalle dice cuál:

```
[SOURCE_ERROR] seller-central: [FRAVEGA GET] https://seller-center-api.fravega.com/api/v1/orders/v95020273frvg-01?orderid=20277852 → 500
[SOURCE_ERROR] vtex: ...
```

Si falla **solo** el detalle de Seller Central, la venta no se bloquea: entra con [datos incompletos](#datos-incompletos).

En un reintento el detalle es el error que devolvió marketplace-api, por ejemplo `[SOURCE_ERROR] [MARKETPLACE GET] /fravega/full-orders/v95020273frvg-01`.

**Qué hacer:** esperar a que Frávega responda y [reintentar la venta](api.md#reintentar-una-venta). No se reintenta sola. Si el error sigue por horas, reclamarle a Frávega con la URL que figura en el detalle.

### `VBI_ERROR`

VBI no dio de alta la venta. En Madre además queda `notification_system_b_status: failed`. El detalle trae lo que respondió VBI, cortado a 300 caracteres:

| Detalle | Qué pasó |
|---|---|
| `PowerApps respondio 400: {...}` (u otro código) | VBI rechazó la venta. La respuesta dice por qué. |
| `PowerApps respondio 200: {"status":"error",...}` | VBI respondió bien pero no la creó. |
| `The operation was aborted due to timeout` | VBI no contestó en 30 segundos. |
| `POWERAPPS_API_URL no configurado` | Al servicio le falta la dirección de VBI. Afecta a todas las ventas. |

**Qué hacer:** leer el detalle. Si fue algo pasajero (timeout, VBI caído), [reintentar la venta](api.md#reintentar-una-venta). Si fue un dato rechazado, corregirlo de donde sale (Frávega) o cargar la venta a mano en VBI.

Reintentar es seguro: VBI reconoce las ventas por su número (`NROVENTA`). Si en realidad la había creado, responde que ya la tiene y no crea otra.

---

## Ventas que no son un error

### `CANCELLED`

La venta ya estaba cancelada o devuelta en Frávega cuando se cargó, o se canceló después. **No es un bloqueo**: es la venta que no hay que cargar. Queda en estado `CANCELLED` (no `FAILED`) con el detalle:

```
[CANCELLED] Seller Central: Canceled (entrega -), VTEX: canceled
```

**Qué hacer:** nada. Si se canceló después de cargarse, la venta ya está en VBI y hay que darla de baja allá a mano: este servicio no da de baja ventas en VBI.

### Datos incompletos

La venta **entró a VBI**, pero sin algún dato del comprador. Queda `PENDING` como cualquier otra y en Teams sale con ⚠️ y una línea `Aviso:`:

```
Aviso: Seller Central no devolvio el detalle de la orden ([FRAVEGA GET] ... → 500): se armo con el listado + VTEX, sin email
```

| Dato que falta | Qué recibe VBI |
|---|---|
| Email | `EMAIL: no-encontrado` |
| CUIL/CUIT y DNI | `CUITCOMPRADOR: no-encontrado` |

**Qué hacer:** si el email hace falta (por ejemplo, para facturar), completarlo en VBI. Reintentar no sirve: la venta ya está en VBI y no está `FAILED`.

---

## Problemas que no llegan a Madre

Estos no dejan la venta `FAILED` porque no se llegó a guardar. Solo aparecen en la respuesta de la carga (`errors`, con su `stage`) y en los registros del servicio.

| Etapa (`stage`) | Mensaje | Qué pasó |
|---|---|---|
| `collect` | `orderId: "(fravega)"` y el error | No se pudo leer el listado de ventas de Frávega. |
| `persist` | El error de Madre | No se pudo consultar Madre para ver si la venta ya existía. Por seguridad no se manda a VBI. |
| `persist` | `No se pudo guardar en madre: ...` | La venta falló o se canceló, y además Madre no la guardó. |
| `persist` | `Enviada a VBI (TLQV-…) pero no se pudo guardar en madre: ... Al volver a sincronizarla VBI la toma como duplicada` | VBI la aceptó, pero Madre no la guardó. |

**Qué hacer:** nada, en general. La carga automática no da por cubierto ese período: la próxima carga vuelve a traer esas ventas. Una que ya estaba en VBI vuelve como duplicada y se guarda sin crear otra.

Si la carga fue manual (con `from` y `to`), hay que volver a lanzarla con el mismo rango.

### Ya hay un proceso en curso

```
409 Ya hay un proceso de ordenes en curso
```

La carga, el seguimiento y el reintento no corren a la vez, porque escriben las mismas ventas en Madre. Si uno está corriendo, el otro se rechaza. Un cron que coincide con otro proceso se saltea y vuelve a correr en el horario siguiente.

**Qué hacer:** esperar a que termine y volver a lanzarlo.

---

## Problemas del seguimiento

El seguimiento informa sus problemas en la respuesta (`errors`, con `uniqueKey` y `message`). La venta sigue `PENDING` y se vuelve a revisar en el siguiente seguimiento.

| Mensaje | Qué pasó |
|---|---|
| El error de marketplace-api | No se pudo leer la venta en Frávega. |
| `No se pudo completar el numero TLQV: ...` | VBI no respondió al pedir el número TLQV. El estado de la venta igual se actualiza. |

---

## Cuáles se reintentan solos

| Problema | ¿Se reintenta solo? |
|---|---|
| `SOURCE_ERROR` | **No.** Las cargas siguientes la saltean: hay que reintentarla a mano. |
| `VBI_ERROR` | **No.** Igual que el anterior. |
| Problemas que no llegan a Madre | **Sí**, en la próxima carga automática. |
| Número TLQV pendiente | **Sí**, en cada seguimiento. |
| Errores del seguimiento | **Sí**, en el siguiente seguimiento. |
| Datos incompletos | No aplica: la venta ya está en VBI. |
