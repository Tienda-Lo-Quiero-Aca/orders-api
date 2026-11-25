# Operación

Dónde corre, cómo se deploya, dónde viven las credenciales, cómo verificar que está sano y qué hacer ante los problemas más frecuentes.

← [Volver al inicio](../README.md)

**Contenido**

1. [Dónde corre](#dónde-corre)
2. [Conectarse al cluster](#conectarse-al-cluster)
3. [Deploy](#deploy)
4. [Configuración y credenciales](#configuración-y-credenciales)
5. [Verificar que está sano](#verificar-que-está-sano)
6. [Correr un proceso a mano](#correr-un-proceso-a-mano)
7. [Problemas frecuentes](#problemas-frecuentes)

---

## Dónde corre

| | |
|---|---|
| Cluster | Kubernetes de DigitalOcean `orders-api` (región `tor1`), namespace `default` |
| Contexto de kubectl | `do-tor1-orders-api` |
| Deployment | `order-api`, **1 réplica** (ver [Limitaciones conocidas](tecnico.md#limitaciones-conocidas)) |
| Service | `order-api-service`, `ClusterIP`, puerto 3000 |
| Entrada | Ingress nginx en `order.api.loquieroaca.com`, con TLS de Let's Encrypt (cert-manager, `letsencrypt-prod`) |
| Imagen | DigitalOcean Container Registry, `order-api:<commit>` |
| Configuración | ConfigMap `order-api-config` (de `k8s/config.yaml`) y Secret `order-api-secrets` (a mano) |

Los servicios de los que depende corren aparte: **marketplace-api** en su propio droplet (se deploya por separado, a mano) y **Madre** en el suyo.

---

## Conectarse al cluster

Hace falta `doctl` con un token personal de DigitalOcean (*API → Generate New Token*). No usar los tokens que crea el deploy (`github-actions-orders-api`, `doks:orders-api:…`, `container-registry-…`).

```bash
doctl auth init                                     # pegar el token cuando lo pida
doctl kubernetes cluster kubeconfig save orders-api # apunta kubectl al cluster
kubectl config current-context                      # tiene que decir do-tor1-orders-api
```

Si `doctl auth init` dice `Using token for context default` y falla con `401`, está usando un token viejo guardado: borrarlo con `doctl auth remove --context default` y volver a correr `doctl auth init`.

Al terminar, para volver al cluster local:

```bash
kubectl config use-context docker-desktop
```

---

## Deploy

**Automático al mergear a `main`.** El workflow `.github/workflows/deploy.yml` corre si cambió algo en `src/`, `k8s/`, `README.md`, `docs/`, `Dockerfile`, `package.json`, `package-lock.json` o el propio workflow. También se puede lanzar a mano desde *Actions → Deploy order-api → Run workflow*.

Qué hace:

1. Construye la imagen (`linux/amd64`) y la sube al registry con el commit corto como tag.
2. Aplica `k8s/config.yaml`, `deployment.yaml` (con la imagen nueva), `service.yaml` e `ingress.yaml`.
3. Espera el rollout, hasta 180 segundos.

**`k8s/config.yaml` pisa el ConfigMap en cada deploy.** Cualquier cambio hecho a mano en el ConfigMap (con `kubectl` o Lens) se pierde en el próximo deploy. Lo que tiene que quedar va en el archivo. Así se apagaron los crons el 6/11: estaban prendidos a mano y el archivo decía `false`.

**El Secret no lo toca el deploy:** se maneja a mano (ver abajo).

**`k8s/cluster-issuer.yaml` no se aplica en el deploy** porque es un recurso de todo el cluster. Se aplica a mano, una sola vez.

**Si el cambio depende de una versión nueva de Madre** (por ejemplo, campos nuevos en `/api/orders/batch`), deployar Madre primero. Con una versión vieja, Madre descarta los campos que no conoce y las ventas quedan sin esos datos.

### Confirmar que quedó la versión nueva

```bash
kubectl get pods -l app=order-api
kubectl get deployment order-api -o jsonpath='{.spec.template.spec.containers[0].image}'
```

El pod tiene que tener pocos minutos de vida y la imagen tiene que terminar en el commit del merge.

---

## Configuración y credenciales

**ConfigMap `order-api-config`**: lo que no es secreto. Sale de `k8s/config.yaml` y se cambia en el repositorio.

**Secret `order-api-secrets`**: se creó a mano y no está en el repositorio (`k8s/secret.example.yaml` muestra las claves).

| Clave | Qué es |
|---|---|
| `POWERAPPS_API_URL` | URL de VBI, con la clave de Azure (`?code=...`). |
| `TEAMS_WEBHOOK_URL` | URL del flujo de Power Automate, con la firma (`&sig=...`). |
| `API_KEY` | Clave del header `x-api-key`. |
| `DOCS_SITE_USER`, `DOCS_SITE_PASSWORD` | Opcionales: con las dos, `/docs` pide clave y publica esta página. |

Ver qué claves tiene y cuánto pesa cada una, **sin mostrar los valores**:

```bash
kubectl describe secret order-api-secrets
```

Sirve para detectar una URL cortada o un valor equivocado: la URL de Teams ronda los 300 bytes y la de VBI los 170.

### Cambiar una sola clave

Con `patch` se cambia una clave sin tocar las demás:

```bash
kubectl patch secret order-api-secrets --type merge -p '{"stringData":{"TEAMS_WEBHOOK_URL":"https://...&sig=..."}}'
kubectl rollout restart deployment/order-api
```

- **Reemplazar el valor de ejemplo por el real.** El 6/11 se corrió el comando con el texto de ejemplo y quedó guardado ese texto (24 bytes): `describe` lo delata.
- **El reinicio es obligatorio:** el pod lee el Secret solo al arrancar.
- No usar `kubectl create secret ... | kubectl apply` salvo que se pasen **todas** las claves: reemplaza el Secret entero y borra las que falten.

---

## Verificar que está sano

**El pod está corriendo:**

```bash
kubectl get pods -l app=order-api
```

**Arrancó con los crons prendidos:**

```bash
kubectl logs deploy/order-api --tail=40 | grep -E "OrdersCronService|successfully started"
```

Tiene que mostrar:

```
[cron orders-sync] 0 0 0,6,12,18 * * * (America/Argentina/Buenos_Aires)
[cron orders-status-sync] 0 0 1,7,13,19 * * * (America/Argentina/Buenos_Aires)
Nest application successfully started
```

Si dice `deshabilitado (ORDERS_SYNC_CRON_ENABLED=false)`, los crons están apagados. Ver [Después de un deploy los crons quedaron apagados](#después-de-un-deploy-los-crons-quedaron-apagados).

Justo después de un rollout, `kubectl logs deploy/...` puede mostrar el pod viejo, que se está apagando. Si hay dos pods, mirar el más nuevo por nombre.

**Responde:**

```bash
curl -s https://order.api.loquieroaca.com/orders/overview/last-24-hours | head -c 300
```

**Cómo salió la última carga:**

```bash
kubectl logs deploy/order-api --since=7h | grep -E "\[dispatch .* -> |\[status-sync\]|\[VBI\]|\[teams"
```

Cada carga deja una línea `[dispatch <desde> -> <hasta>] collected=… dispatched=… failed=…`, y cada alta en VBI una `[VBI] NROVENTA=… HTTP 200: {...}`.

---

## Correr un proceso a mano

Para no copiar la `API_KEY` a la máquina local, el pedido se puede hacer desde adentro del pod, que ya la tiene:

```bash
kubectl exec deploy/order-api -- node -e "fetch('http://localhost:3000/orders/fravega/sync',{method:'POST',headers:{'x-api-key':process.env.API_KEY}}).then(async r=>console.log(r.status, await r.text()))"
```

Cambiando la ruta sirve para `status-sync` y para `retry/<suborderId>`. **Estos procesos dan de alta ventas reales en VBI.**

También se puede usar Swagger (`/api/docs`, botón **Authorize**) con la clave.

---

## Problemas frecuentes

### Después de un deploy los crons quedaron apagados

El deploy aplica `k8s/config.yaml`. Si ahí dicen `false`, quedan apagados, aunque se hayan prendido a mano en el cluster.

**Qué hacer:** dejar `ORDERS_SYNC_CRON_ENABLED` y `ORDERS_STATUS_CRON_ENABLED` en `'true'` en el archivo y mergear. Para prenderlos ya, sin esperar el deploy:

```bash
kubectl patch configmap order-api-config --type merge -p '{"data":{"ORDERS_SYNC_CRON_ENABLED":"true","ORDERS_STATUS_CRON_ENABLED":"true"}}'
kubectl rollout restart deployment/order-api
```

Después, cargar a mano el período en que estuvieron apagados con `POST /orders/fravega/sync?from=...&to=...`.

### Teams no avisa

En los registros aparece `[teams …] no se pudo notificar: Teams respondio 401: … AuthorizationFailed`.

El `401` lo devuelve Power Automate antes de ejecutar el flujo: la URL o la firma no valen. Causas vistas:

- **La URL es de otro flujo** (uno viejo o regenerado). Copiar la URL actual del disparador del flujo (*When a Teams webhook request is received*) y cargarla con [`patch`](#cambiar-una-sola-clave).
- **Quedó guardado el texto de ejemplo** en lugar de la URL. Se ve en `kubectl describe secret`: pesa mucho menos de 300 bytes.
- **El disparador exige login.** En el flujo, *Who can trigger the flow* tiene que estar en **Anyone**.

Un `202` de Power Automate solo dice que el flujo arrancó. Si no aparece la tarjeta, el error está en el historial de ejecuciones del flujo.

Una venta que no se avisó por esto igual quedó cargada. Teams no se reintenta solo.

### Una venta no entró a VBI

Está `FAILED` en Madre y salió con 🔴 en Teams. El motivo está en `last_error`. Ver [Bloqueos](bloqueos.md) y, cuando se pueda, reintentarla:

```bash
kubectl exec deploy/order-api -- node -e "fetch('http://localhost:3000/orders/fravega/retry/v95020273frvg-01',{method:'POST',headers:{'x-api-key':process.env.API_KEY}}).then(async r=>console.log(r.status, await r.text()))"
```

### Seller Central devuelve 500

Es frecuente con el detalle por suborden. Las ventas entran igual sin email (⚠️ en Teams), porque marketplace-api usa el listado más VTEX. Solo se bloquean (`SOURCE_ERROR`) si además falla VTEX.

Para ver si una venta en particular responde, sin cargar nada:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://api.marketplace.loquieroaca.com/fravega/full-orders/v95020273frvg-01?orderid=20277852"
```

Si una venta sigue sin responder durante horas, reclamarle a Frávega con la URL de Seller Central que figura en `last_error`.

### Todas las ventas fallan con VBI_ERROR

Si el detalle es `POWERAPPS_API_URL no configurado`, al pod le falta la URL de VBI: revisar el Secret y reiniciar. Si es otro, VBI está rechazando o caído: ver el detalle en los registros (`[VBI] NROVENTA=…`).

### Los procesos responden 500 "API key no configurada en el servidor"

Falta `API_KEY` en el Secret. Agregarla con [`patch`](#cambiar-una-sola-clave) y reiniciar.

### Un proceso responde 409

Ya hay una carga, un seguimiento o un reintento en curso. Esperar a que termine: los registros muestran cuándo (`[dispatch …]` o `[status-sync]`).

### Una venta no tiene número TLQV

Es normal en las primeras horas: VBI lo asigna después de crear la venta. El seguimiento lo completa solo. Si después de varios seguimientos sigue vacío, buscar en los registros `No se pudo completar el numero TLQV`.

### El servicio no arranca

Si los registros dicen `MARKETPLACE_API_BASE_URL is not defined` o `MADRE_API_BASE_URL is not defined`, falta esa variable en `k8s/config.yaml`.

### Cambié la documentación y el sitio no la muestra

Los textos van dentro de la imagen: se publican cuando el cambio llega a `main` y termina el deploy. El navegador puede guardar la página: recargar sin caché.

### kubectl muestra otro cluster

`kubectl config current-context` tiene que decir `do-tor1-orders-api`. Si dice `docker-desktop` u otro, ver [Conectarse al cluster](#conectarse-al-cluster). En los comandos de este documento se puede agregar `--context do-tor1-orders-api` para no depender de eso.
