# Bitácora de Desarrollo — GDM IVA

Registro cronológico del desarrollo y despliegue del Portal de IVA.

---

## 📍 Estado actual: PRODUCCIÓN ✅

- **URL:** https://iva.hcgm.com.mx (con SSL)
- **Hosting:** Render.com — plan Starter + disco persistente 1 GB
- **Costo mensual:** $7.25 USD (~$145 MXN)
- **Repo:** https://github.com/anbeor29-oss/GDM_IVA
- **Modo:** Pruebas (MODO_PRODUCCION=false, sin restricción día 10-28)

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
- Los XMLs son TEMPORALES (se limpian día 28)
- Solo necesitamos persistir BD y e.firmas
- Reduce costo de disco a 1 GB ($0.25/mes)

---

## ⏭️ Pendientes para próximas iteraciones

- [ ] Activar `MODO_PRODUCCION = true` (restringir días 10-28)
- [ ] Configurar CNAME `iva.hcgm.com.mx` → `gdm-iva.onrender.com`
- [ ] Aviso de privacidad (link en footer)
- [ ] Términos de uso (link en footer)
- [ ] Reportes históricos (consultar meses anteriores)
- [ ] Export a Excel/PDF del reporte mensual
- [ ] Notificaciones por email cuando termine la descarga
- [ ] Dashboard del admin con estadísticas de uso

---

*Última actualización: 2026-06-11*
