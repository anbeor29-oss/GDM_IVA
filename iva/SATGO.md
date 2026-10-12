# Motor de descarga SAT por **SatGo**

> Desde **2026‑10‑07** la descarga de CFDIs del SAT se hace por **SatGo** (REST),
> sustituyendo a `@nodecfdi/sat-ws-descarga-masiva`. Se usa la **misma e.firma** del
> cliente y el **mismo flujo oficial** del SAT (solicita → verifica → descarga).

---

## ¿Por qué SatGo?

El motor `@nodecfdi` daba problemas intermitentes (errores opacos del SDK, 301 en
recibidos, etc.). SatGo envuelve el **mismo web service oficial** del SAT por REST y
maneja SOAP/reintentos del lado de ellos. La e.firma sigue viajando (multipart) y
nunca se manda a un tercero distinto del propio SatGo.

> `@nodecfdi` queda **instalado** en `package.json` pero **sin uso** (se puede quitar
> en una limpieza futura).

---

## Motor actual: consulta **SÍNCRONA** (`facfiel`) — desde 2026‑10‑12

La descarga masiva (abajo) es **asíncrona**: el SAT encola la solicitud y arma el
paquete, y "recibidos" tardaba **30+ min "verificando"**. Por eso el motor pasó a la
consulta **síncrona**:

> **`POST /api/v2/Consultar/facfiel`** — misma **e.firma (FIEL)**, `tipo`
> (emitidos/recibidos), `tipoBusqueda=1`, `fecha_inicial`/`fecha_final`,
> `descargaComprobantes=true`. Devuelve `comprobantes[]`, cada uno con su **XML en
> base64 en el campo `content`**, en **una sola llamada** (segundos).

- `satgo.consultaFac()` hace la llamada; `download.js` pide emitidos y recibidos **en
  paralelo**, decodifica `content`, escribe los XML a la carpeta del mes (snapshot:
  limpia antes para no dejar cancelados viejos) y corre el mismo `calcularIVA`.
- **Cancelados:** se filtran en código por `estadoDeComprobante` (contiene "cancel").
- **Alto volumen:** si `facfiel` devuelve sólo `requestId` (sin comprobantes), hay que
  caer al flujo asíncrono de abajo (pendiente de implementar ese *fallback*).

> El flujo de 3 pasos de abajo **sigue en `satgo.js`** (solicita/verifica/descarga)
> como respaldo, pero **ya no es el camino normal**.

---

## Flujo asíncrono de respaldo (3 pasos) — `src/sat/satgo.js`

1. **`solicita`** → `POST /api/v2/SatWebService/solicita`
   - query: `tipo=emitidos|recibidos`, `fecha_inicial`, `fecha_final` (`yyyy-MM-dd HH:mm:ss`),
     `tipoBusqueda=CFDI`, `estadoComprobante=Vigente` (excluye cancelados).
   - body multipart: `Certificado` (.cer), `llavePrivada` (.key), `Contrasena`.
   - → `idSolicitud`.
2. **`verifica`** → `POST /api/v2/SatWebService/verifica?IdSolicitud=` → `estadoSolicitud`
   (**3 = terminada**) + `idsPaquetes[]`.
3. **`descarga`** → `POST /api/v2/SatWebService/descarga?IdPaquete=` → `paqueteBase64`
   (ZIP con los XML, se extraen con `adm-zip`).

### Autenticación (dos niveles)

```
token del portal (web.sat-go.com, CADUCA)
        │  POST /api/v1/Users/CreateKey   (Authorization: Bearer <portal>)
        ▼
API Key PERMANENTE  ──►  va en la variable  SATGO_API_KEY
        │  POST /api/Auth/token?key=<API Key>
        ▼
JWT corto (Bearer)  ──►  se cachea ~4 min; va en cada solicita/verifica/descarga + header RFC
```

El código (`getJwt`) usa `SATGO_API_KEY` si está; si no, canjea `SATGO_PORTAL_TOKEN`
por una API Key con `CreateKey`. **Lo correcto en producción es poner la API Key
permanente en `SATGO_API_KEY`** (el token del portal caduca).

---

## Variables de entorno (servicio `iva` en Render)

| Variable | Qué es | Obligatoria |
|---|---|---|
| `SATGO_API_KEY` | **API Key permanente** de SatGo (la que da `CreateKey`) | ✅ Sí |
| `SATGO_PORTAL_TOKEN` | Token del portal; solo si no hay API Key (IVA la genera) | Alterna |
| `SATGO_BASE_URL` | Base; por defecto `https://api.sat-go.com` | No |

> La **misma cuenta SatGo** que usa **NEXO** (`gdm-almacen-backend`). NEXO guarda su
> API Key cifrada en su BD; IVA la lee de la variable de entorno.

---

## Cómo obtener una `SATGO_API_KEY` válida

**Debe ser la API Key PERMANENTE, no el token del portal.** Dos formas:

### A) Del portal
`web.sat-go.com` → inicia sesión → sección **API Key / Llaves / Developers** → copia
(o genera) la key. Pégala en Render → `iva` → Environment → `SATGO_API_KEY`
(**sin comillas ni espacios**).

### B) Generarla con CreateKey (necesita el token del portal)
El token del portal se saca de `web.sat-go.com` (DevTools → Network → header
`Authorization: Bearer …`) **o** del env `SATGO_PORTAL_TOKEN` de NEXO.

```powershell
$portal = "PEGA_EL_TOKEN_DEL_PORTAL"
$r = Invoke-RestMethod -Method Post -Uri "https://api.sat-go.com/api/v1/Users/CreateKey" -Headers @{ Authorization = "Bearer $($portal.Trim())" }
$r | ConvertTo-Json -Compress   # el campo apiKey/key es la permanente
```

Verificar que una key es válida (debe devolver un token, no 401):

```powershell
$key = "PEGA_LA_API_KEY"
Invoke-RestMethod -Method Post -Uri "https://api.sat-go.com/api/Auth/token?key=$([uri]::EscapeDataString($key.Trim()))"
```

---

## Periodo de descarga (fechas) — `src/sat/download.js`

El SAT **rechaza fechas finales en el futuro o del día en curso** (error
*"Fecha final invalida"*). Por eso el rango que se pide es:

- **Normal:** día **1** del mes en curso → **AYER 23:59:59**.
- **Día 1 del mes:** baja el **mes anterior completo** (se guarda/lee como mes en
  curso para que el dashboard no salga vacío).

Todo se calcula con el **reloj de `America/Mexico_City`** (el SAT opera en hora del
centro). Si se calculara con la hora UTC del servidor de Render, al anochecer en
México el servidor ya estaría en el día siguiente y el SAT rechazaría la fecha.
`parser.js` (`calcularIVA`) usa el **mismo reloj de México** para leer la carpeta del
mes correcto (evita desfases de mes en la noche).

> Carpeta en disco: `TEMP_XML_PATH/<RFC>/<AAAAMM>/{emitidos,recibidos}`.
> Se limpia sola (ver `src/scheduler/tasks.js`).

---

## Troubleshooting (errores vistos y su causa)

| Mensaje en el banner | Causa | Solución |
|---|---|---|
| `SatGo Auth/token respondió 401 … Invalid key` | `SATGO_API_KEY` no es una API Key válida (pegaron el token del portal, o trae espacios/comillas, o es de otra cuenta) | Poner la **API Key permanente** (sección de arriba), sin espacios ni comillas; redeploy |
| `La solicitud de descarga no es válida. Fecha final invalida` | La fecha final era futura (se pedía hasta el último día del mes) | **Resuelto** (commit `68b9225`): rango día 1 → ayer, hora de México |
| `Falta SATGO_API_KEY (o SATGO_PORTAL_TOKEN) …` | No hay ninguna de las dos variables en el env | Poner `SATGO_API_KEY` en Render |
| `0 emitidos, 0 recibidos` (sin error) | No hay CFDIs vigentes en el rango | Normal (no es error) |

> Desde el commit `4d3a1e5`, el error incluye el **cuerpo de la respuesta de SatGo**
> (p. ej. `Invalid key`) y, ante un 401, una pista de qué revisar.

---

*Actualizado: 2026‑10‑07*
