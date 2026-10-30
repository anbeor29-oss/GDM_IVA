# Bitácora de Desarrollo — GDM IVA

Registro cronológico del desarrollo y despliegue del Portal de IVA.

---

## 📍 Estado actual: PRODUCCIÓN ✅

- **URL:** https://iva.hcgm.com.mx (con SSL)
- **Hosting:** Render.com — plan Starter + disco persistente 1 GB
- **Costo mensual:** $7.25 USD (~$145 MXN)
- **Repo:** https://github.com/anbeor29-oss/GDM_IVA
- **Motor SAT:** **SatGo** (REST) desde 2026-10-07 — ver `SATGO.md`
- **Modelo:** comercial (autoregistro + 2 pruebas + anualidad) — ver `COMERCIALIZACION.md`

---

## 🗓️ Línea de tiempo

### 📅 2026-05-30 — Inicio del proyecto

Construcción del sistema base:
- Servidor Express + SQLite + sesiones
- Panel admin con CRUD de clientes y subida de e.firma
- Login de clientes con bcrypt
- Cliente SAT manual (SOAP + XMLDSig con node-forge)
- Parser CFDI 3.3 / 4.0
- Dashboard split-screen
- Scheduler de limpieza día 30

### 📅 2026-05-31 — Conexión SAT

Iteración para hacer funcionar la descarga del SAT:
- ❌ Endpoints antiguos del SAT (404)
- ✅ Actualizar a `cfdidescargamasivasolicitud.clouda.sat.gob.mx`
- ❌ Firma XMLDSig con `xml-crypto` falla con InvalidSecurity 500
- ✅ Reescribir firma manualmente con node-forge
- ❌ `parseAttributeValue: true` convierte "002" → 2 (parser fallaba)
- ✅ Cambiar a `parseAttributeValue: false`
- ❌ `TEMP_XML_PATH=C:\temp2xml` interpretaba `\t` como TAB
- ✅ Forward slashes: `C:/temp2xml`

### 📅 2026-06-01 — Bugs y diagnóstico

- ✅ Corregir cálculo de fechas (`ayer` no `now` para mes inicial)
- ✅ Aumentar threshold `ceroCount` 3→8 (~4 min de gracia)
- ✅ Regex `<Paquete>` tolera prefijos de namespace
- ⏳ R (recibidas) sigue con CodEstatus=301

### 📅 2026-06-02 — Pruebas reales con clientes

- ✅ Descarga exitosa: RFC GOJR730617E8A (Ramón) — 17 XMLs
- ✅ Confirmado: parser incluye REPs e ignora I+PPD correctamente
- 🐛 REPs mostraban `SubTotal=$0 / Total=$0` (bug)
- ✅ Fix: leer `pago20:Totales` para REPs (no del Comprobante)

### 📅 2026-06-04 — Refactor parser fiscal

- ✅ Parser reescrito con reglas LIVA Art. 5 y 17
- ✅ I+PPD se EXCLUYE (IVA diferido al REP)
- ✅ REP suma IVA (tanto emitido como recibido)
- ✅ Egresos (Notas de Crédito) restan IVA
- ✅ Dashboard muestra columna "Tipo" con chips de color
- ✅ Mensajes de error específicos por tipo (E/R)

### 📅 2026-06-04 — Arquitectura background job

- ✅ Refactor a sistema de jobs en background
- ✅ HTTP responde inmediatamente con `jobId`
- ✅ Cliente hace polling cada 8s a `/api/estado-descarga/:jobId`
- ✅ Soluciona timeout del navegador con SAT lento

### 📅 2026-06-05 — Solución definitiva R (recibidos)

**El gran descubrimiento:**

- ❌ Nuestro código SOAP manual generaba CodEstatus=301 en R
- ✅ Migrar al paquete oficial **`@nodecfdi/sat-ws-descarga-masiva`**
- 🔑 **Hallazgo clave:** El SAT requiere `DocumentStatus('active')` en R+XML
- ✅ Sin ese parámetro → 301 "cancelados"
- ✅ Con ese parámetro → "Solicitud Aceptada" ✨

Esto resolvió el bloqueo que tuvimos varios días.

### 📅 2026-06-06 — Branding GDM

- ✅ Rebranding a "IVA — Grupo GDM High Consulting México"
- ✅ Página `acceso-denegado.html` con CTA WhatsApp para no-clientes
- ✅ Mensaje exclusivo: "Servicio exclusivo para clientes GDM. Si aún no eres cliente, pide informes al WhatsApp 443 367 7027"
- ✅ Modal de avisos antes de descargar del SAT (3 reglas importantes)

### 📅 2026-06-07 — Decisión de hosting

- ❌ Hosting México plan básico NO soporta Node.js
- 💡 Plan B: Render.com (free tier) + subdominio en hcgm.com.mx
- ✅ Crear repo GitHub: `anbeor29-oss/GDM_IVA`
- ✅ Estructura del repo: sitio público + carpeta `iva/` con la app
- ✅ Subir todo por interfaz web (sin Git instalado)
- ✅ Conectar Render → desplegar
- 🐛 Bugs en deploy:
  - Root Directory `IVA` (mayús) → `iva` (minús)
  - Rate limiter bloqueaba la IP del usuario por static assets
  - `ipBlockMiddleware` causaba loop redirigiendo a `/error-ataque.html`
- ✅ Todo resuelto, servicio Live

### 📅 2026-06-08 — Producción y dominio

- ✅ Upgrade a **Render Starter** ($7 USD/mes)
- ✅ Disco persistente 1 GB en `/var/data` ($0.25 USD/mes)
- ✅ Adaptar código: `DATA_DIR` y `UPLOADS_DIR` configurables
- ✅ Confirmado: los datos persisten entre reinicios
- ✅ Pruebas exitosas con varios clientes
- ✅ Descargas SAT funcionando consistentemente

### 📅 2026-06-11 — Integración hcgm.com.mx

- ✅ Sitio público `hcgm.com.mx` actualizado con:
  - Menú "⚡ IVA" destacado en azul vibrante
  - Banner "¡NUEVO!" en el hero (al principio)
  - Sección IVA con gradient `#1e3a8a → #2563eb → #1d4ed8`
  - CTA final antes del footer con botón dorado
  - Link "⚡ Portal de IVA →" en el footer
- ✅ Botones apuntan a `https://iva.hcgm.com.mx/login`

### 📅 2026-10-07 — Comercialización, motor SatGo y fix de fechas

Salto grande respecto a junio (entre medias: PWA instalable, `MODO_PRODUCCION`,
soporte `DATA_DIR`/`UPLOADS_DIR`). Lo de hoy:

- ✅ **Comercialización v1** (commits `98e5fef` + `f8857d8`): autoregistro público
  (`/registro`) con **2 consultas de prueba** → `BLOQUEADO` → **$500+IVA anual** / 365
  días al "Marcar pagado". Clientes GDM (`origen=ADMIN`) sin límite. Usuario = correo +
  contraseña temporal; e.firma en el primer acceso. Ver **`COMERCIALIZACION.md`**.
- ✅ **Descarga a Excel = servicio de pago por usuario** (`excel_habilitado`, default 0
  para TODOS): botón/ruta ocultos sin permiso; checkbox en el admin; se enciende al pagar.
- ✅ **Motor de descarga cambiado a SatGo** (`src/sat/satgo.js` + `download.js`),
  sustituye a `@nodecfdi`. Misma e.firma, mismo flujo. Ver **`SATGO.md`**.
- ✅ Admin: botones de acción con **iconos alineados** + checkbox Excel.
- ✅ Registro/e.firma/login: textos y nota de confianza de la e.firma.
- 🐛 **401 "Invalid key"** → la `SATGO_API_KEY` de Render no era la API Key permanente.
  Fix = operación (poner la key correcta). Mensaje de error mejorado en commit `4d3a1e5`.
- 🐛 **"Fecha final invalida"** (el SAT) → el motor pedía hasta el último día del mes
  (futuro). Fix (commit `68b9225`): rango **día 1 → ayer**, en **hora de México**
  (`download.js` + `parser.js`), con caso especial del día 1.

Commits del día: `98e5fef`, `f8857d8`, `4d3a1e5`, `68b9225`.

---

## 🐛 Bugs históricos y soluciones

| Bug | Causa raíz | Solución |
|---|---|---|
| 404 en autenticación SAT | Endpoints desactualizados | URLs nuevas de `cfdidescargamasivasolicitud.clouda.sat.gob.mx` |
| InvalidSecurity 500 | Firma XMLDSig mal estructurada | Construir firma manualmente con node-forge |
| Parser ignoraba IVAs | `parseAttributeValue:true` convertía "002" → 2 | Cambiar a `false` |
| TEMP_XML_PATH inválido | `\t` interpretado como TAB en `.env` | Forward slashes |
| Rate limiter bloqueaba al usuario | Aplicado a GET y a estáticos | Solo en POST + skipSuccessfulRequests |
| ERR_TOO_MANY_REDIRECTS | ipBlockMiddleware redirigía la página de error a sí misma | Exceptuar `/error-ataque.html` y assets |
| R devolvía CodEstatus=301 | Faltaba `DocumentStatus('active')` en query | Agregar al QueryParameters |
| REPs con $0 en SubTotal/Total | Comprobante de REP siempre es 0 por spec | Leer `pago20:Totales` |
| BD se perdía en reinicios | Disco efímero en plan free | Upgrade a Starter + disco persistente |
| Root directory error en Render | `IVA` vs `iva` (case-sensitive en Linux) | Usar siempre minúsculas |
| Loop redirect en admin | Form action relativo `admin/login` desde `/admin/login` | Cambiar a path absoluto `/admin/login` |

---

## 📊 Reglas fiscales implementadas

### IVA Trasladado (Cobrado a clientes)
- **I + PUE emitido:** ✅ IVA al emitir
- **REP emitido (yo cobré):** ✅ IVA al recibir el pago
- **E emitido (nota de crédito):** ✅ Resta IVA cobrado previamente

### IVA Acreditable (Pagado a proveedores)
- **I + PUE recibido:** ✅ IVA al pagar (contado)
- **REP recibido (yo pagué a proveedor):** ✅ IVA al hacer el pago
- **E recibido (nota de crédito):** ✅ Resta IVA acreditado previamente

### Excluidos
- **I + PPD (cualquier dirección):** IVA diferido — espera al REP
- **T (Traslado):** No genera IVA
- **N (Nómina):** Exento por Art. 15 fracc. X LIVA

---

## 🔐 Decisiones de arquitectura

### ¿Por qué SQLite en lugar de PostgreSQL?
- Pocos usuarios concurrentes (clientes consultan 1-2 veces al mes)
- Disco persistente de Render lo respalda
- Cero configuración, cero costo extra

### ¿Por qué Render.com en lugar de VPS?
- Cliente no quiere administrar Linux
- Despliegue automático con `git push`
- HTTPS Let's Encrypt automático
- Costo similar a VPS ($7 vs $5) pero menos trabajo

### ¿Por qué el paquete oficial @nodecfdi?
- Maneja todos los detalles del SOAP correctamente
- Mantenido por la comunidad mexicana de CFDI
- Resuelve el problema de XMLDSig de R que nosotros no pudimos resolver manualmente

### ¿Por qué disco persistente solo para `data/` y `uploads/`?
- Los XMLs son TEMPORALES (se limpian el día 1 de cada mes)
- Solo necesitamos persistir BD y e.firmas
- Reduce costo de disco a 1 GB ($0.25/mes)

---

## 2026-10-29 — Panel admin que sí responde, Excel en hojas y puente a NEXO

**Botones muertos (causa raíz).** Helmet trae por defecto `script-src-attr 'none'`: TODOS los `onclick`/`onchange`
del HTML quedaban bloqueados en silencio (Eliminar y el check de Excel "no hacían nada"). Fix en `server.js`:
`scriptSrcAttr: ["'unsafe-inline'"]` (scriptSrc ya era inline; no abre más). Commit `69bd7e4`.

**Admin (`views/admin/dashboard.html`, `src/routes/admin.js`):**
- Casilla a la izquierda de cada cliente + «Eliminar seleccionados» (`POST /admin/usuarios/eliminar-lote`). No borra
  los archivos de e.firma si otra cuenta del MISMO RFC los usa. Las acciones van por `fetch` (`accionAdmin` avisa si la
  sesión expiró).
- Fuera el botón «Pagado». **«+ Créditos»** pregunta primero si pagó la **ANUALIDAD** → `POST /admin/usuarios/:id/pagar`
  (activa 1 año + Excel) y avisa a NEXO; si no, acredita créditos (opcional). Al final abre NEXO → Facturación → IVA
  (`/admin/usuarios/:id/nexo`).

**Excel del cliente:** tres hojas «IVA cobrado» (emitidos), «IVA acreditable» (recibidos) y «Resumen».

**Fechas de la anualidad (`aa02294`):** `marcarPagado` usa hora de México y vence el **MISMO día del año siguiente**
(29/10/2026 → 29/10/2027); nueva columna `usuarios.pagado_desde`.

**Puente a NEXO (`src/nexo-sync.js`):** cada autoregistro y cada pago se envían a
`NEXO_API_URL/integracion/iva/cliente` (default `https://gdm-almacen-backend.onrender.com/api/v1`) con
`x-iva-token: NEXO_IVA_TOKEN` (= `IVA_INTEGRACION_TOKEN` del backend de NEXO). Sin token no hace nada y no rompe el
alta. Registro → «Solicitudes en prueba»; pago → «Usuarios reales» con próximo cobro.

**Operación 2026-10-29:** PABJ7311218L8 y GOJR730617E8A → ACTIVO, anualidad 29/10/2026–29/10/2027, Excel, en NEXO.

---

## 2026-10-30 — Sesiones que sobreviven a Render, ventana día 2→fin y Excel con formato

**Sesiones en disco (`d81d31d`).** `express-session` usaba su **MemoryStore** por defecto (sesiones en RAM); en
Render el proceso se reinicia (deploy) y se duerme (inactividad) y esa RAM se borra → el admin se salía solo y las
acciones por `fetch` recibían un 302 al login sin ejecutarse. Fix: **nuevo `src/db/session-store.js`**, un store
mínimo de express-session sobre la MISMA base better-sqlite3 (disco persistente), **sin dependencias nuevas**;
`server.js` lo usa con `rolling:true`. Escape `COOKIE_SECURE=false` **solo** si Cloudflare quedara en modo Flexible
(ahí `secure:true` impide guardar la cookie). *(Junto con el fix de CSP `69bd7e4`, el panel ya responde: eran dos
causas distintas del mismo síntoma — handler inline bloqueado por CSP + sesión perdida por reinicio.)*

**Ventana de consulta = día 2 al último del mes (`87638df`).** Estaba repetida y desincronizada (auth.js día 3-29 con
`MODO_PRODUCCION=true`; dashboard.js día 3-29 pero `=false`, sin efecto; y el login decía «del 10 al 29»). Ahora **una
sola definición** en **`src/ventana.js`**: `dentroDeVentana()` = `getDate() >= 2`. El **día 1 queda fuera** a propósito
(ese día el scheduler borra los XML del mes anterior). `TEXTO_VENTANA` centraliza el mensaje; `VENTANA_OFF=true` lo
desactiva para pruebas. `auth.js`/`dashboard.js` importan el módulo; `public/login.html` dice «del día 2 al último día
de cada mes». La limpieza del día 1 (`scheduler/tasks.js`, cron `5 0 1 * *`) ya existía.

**Excel con formato de la casa + pie bloqueado (`9ce039c`).** El export (`GET /dashboard/exportar`) pasa del armado
crudo con adm-zip (sin estilos) a **ExcelJS** (dep nueva **`exceljs ^4.4.0`**, misma que NEXO; adm-zip se queda, lo usa
la descarga SatGo). Replica el formato medido de la hoja del usuario: Aptos Narrow 11; encabezado fila 3 fondo oro
`FFFFC000` centrado; título fila 1 negrita+cursiva; importes `#,##0.00`; «Resumen» con Trasladado rojo, Acreditable
verde `FF196B24`, resultado azul `FF002060` negrita, y el **pie «GDM NEXO / informes whatsapp (449) 367 70 27»** (verde,
negrita+cursiva). **El pie es inamovible:** en «Resumen» se bloquean SOLO **A9:A10** y la hoja se protege con una
contraseña **aleatoria que no se guarda** (ni el dueño quita el candado). ⚠️ La protección de Excel es disuasivo, no
cifrado (se puede romper con herramientas; para algo inviolable, PDF). La ruta `exportar` ahora es `async`.

---

## ⏭️ Pendientes para próximas iteraciones

- [x] Ventana de consulta activa: **día 2 → último del mes** (`src/ventana.js`), limpieza día 1
- [x] Export a Excel con **formato de la casa + pie bloqueado (A9:A10)** — **PDF aún pendiente**
- [ ] Términos de uso (link en footer)
- [ ] Reportes históricos (consultar meses anteriores)
- [ ] Notificaciones por email cuando termine la descarga
- [ ] Envío real de los recibos/reportes por correo (hoy no existe; se marca, no se manda)
- [ ] Dashboard del admin con estadísticas de uso

---

*Última actualización: 2026-10-30*
