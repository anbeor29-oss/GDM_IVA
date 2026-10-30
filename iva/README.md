# GDM IVA — Portal de Consulta de IVA SAT

> Aplicación web para que los clientes de **Grupo GDM High Consulting México**
> consulten su IVA mensual descargando CFDIs directamente del SAT con su e.firma.

**Producción:** https://iva.hcgm.com.mx
**Repo:** https://github.com/anbeor29-oss/GDM_IVA

---

> ### ⚠️ Actualización 2026‑10‑07 (lee estos docs primero)
> Este README describe la versión original. Cambios vigentes:
> - **Motor SAT = SatGo** (REST), ya **no** `@nodecfdi`. → **[`SATGO.md`](SATGO.md)**
>   (incluye cómo obtener `SATGO_API_KEY` y el troubleshooting de 401 / "Fecha final invalida").
> - **Modelo comercial**: autoregistro + 2 pruebas + anualidad $500+IVA; Excel de pago por
>   usuario. Ya **no** es "solo clientes GDM". → **[`COMERCIALIZACION.md`](COMERCIALIZACION.md)**
> - Variable nueva imprescindible: **`SATGO_API_KEY`** (API Key permanente de SatGo).
> - **2026‑10‑30**: ventana de consulta **día 2 → último del mes** (`src/ventana.js`), **sesiones en
>   disco** (sobreviven a reinicios de Render) y **Excel con formato de la casa + pie bloqueado**.
> - Bitácora completa: **[`BITACORA.md`](BITACORA.md)**.

---

## 🎯 Descripción

Sistema web que automatiza la consulta del IVA mensual de los clientes:

1. **Cliente entra** con usuario/contraseña asignados por el admin
2. **Clic en "Descargar del SAT"** → la app autentica con su e.firma y solicita los CFDIs del mes
3. **El sistema clasifica** los comprobantes según reglas fiscales (LIVA Art. 5 y 17)
4. **Muestra en dashboard split-screen:**
   - Izquierda: IVA Trasladado (cobrado a clientes)
   - Derecha: IVA Acreditable (pagado a proveedores)
5. **Calcula automáticamente:** IVA a Cargo o IVA a Favor del mes

---

## 🏗️ Arquitectura

```
┌─────────────────────┐         ┌─────────────────────┐
│  hcgm.com.mx        │  link   │  iva.hcgm.com.mx    │
│  (Hosting México)   │ ──────▶ │  (Render.com)       │
│  HTML estático      │         │  Node.js + Express  │
└─────────────────────┘         └──────────┬──────────┘
                                            │
                                  ┌─────────▼─────────┐
                                  │  SAT — Descarga   │
                                  │  Masiva CFDI      │
                                  │  (SOAP + XMLDSig) │
                                  └───────────────────┘
```

### Stack técnico

- **Node.js 20+ / Express 5** — servidor web
- **SQLite (better-sqlite3)** — BD local (admin, clientes) y almacén de sesiones
- **SatGo (REST)** — motor de descarga de CFDIs del SAT con e.firma (ver `SATGO.md`); `@nodecfdi` queda instalado pero **sin uso**
- **node-forge** — manejo de e.firma (X.509 + RSA)
- **express-session** — sesiones HTTP, con **store en SQLite** (`src/db/session-store.js`) para que sobrevivan a los reinicios de Render
- **helmet + express-rate-limit** — seguridad HTTP (CSP con `script-src-attr 'unsafe-inline'` para los `onclick`/`onchange` del panel)
- **node-cron** — tareas programadas (limpieza de XML el **día 1**)
- **fast-xml-parser** — parseo de CFDIs
- **ExcelJS** — exportación del IVA a `.xlsx` con formato de la casa y pie de marca bloqueado

---

## 📂 Estructura del proyecto

```
iva/
├── server.js              ← Entrada principal
├── render.yaml            ← Config de Render
├── package.json
├── .gitignore
├── .env.example
├── README.md
│
├── src/
│   ├── db/
│   │   ├── database.js       ← SQLite + cifrado AES-256-GCM (admin, clientes, créditos)
│   │   └── session-store.js  ← Store de sesiones sobre la misma SQLite (sobrevive a reinicios)
│   ├── sat/
│   │   ├── satgo.js          ← Cliente SatGo (REST + e.firma) — motor actual
│   │   ├── download.js       ← Orquesta la descarga del mes (vía SatGo)
│   │   └── parser.js         ← Reglas fiscales LIVA
│   ├── ventana.js            ← Ventana de consulta: día 2 → último del mes (única definición)
│   ├── nexo-sync.js          ← Puente a NEXO (altas y pagos de IVA)
│   ├── security/
│   │   ├── rateLimiter.js    ← Anti-DOS y bloqueo de IPs
│   │   └── attackHandler.js
│   ├── scheduler/
│   │   └── tasks.js          ← Limpieza automática de XML el día 1
│   ├── jobs/
│   │   └── manager.js     ← Manager de jobs de descarga
│   └── routes/
│       ├── auth.js        ← Login cliente
│       ├── admin.js       ← CRUD clientes + e.firma
│       └── dashboard.js   ← API IVA + polling de jobs
│
├── views/
│   ├── dashboard.html     ← Panel del cliente (split-screen)
│   └── admin/
│       ├── login.html
│       ├── dashboard.html
│       ├── usuario-form.html
│       └── cambiar-password.html
│
└── public/                ← Estáticos servidos directo
    ├── login.html
    ├── acceso-denegado.html  ← CTA WhatsApp para no-clientes
    ├── error-ataque.html
    ├── css/styles.css
    └── js/antiCapture.js
```

---

## 🧮 Reglas fiscales del parser

Implementadas según **Art. 5 fracc. IV y Art. 17 LIVA**:

| TipoComprobante | MetodoPago | Panel  | Acción |
|----------------|------------|--------|--------|
| I (Ingreso)    | PUE        | Ambos  | ✅ IVA al emitir factura |
| I (Ingreso)    | PPD        | —      | ❌ EXCLUIDO — IVA diferido al REP |
| P (REP)        | —          | Ambos  | ✅ IVA al cobrar/pagar |
| E (Egreso)     | —          | Ambos  | ✅ Resta IVA (Nota de Crédito) |
| T (Traslado)   | —          | —      | ❌ Sin IVA |
| N (Nómina)     | —          | —      | ❌ Sin IVA (Art. 15 fracc. X LIVA) |

**Para REPs (Tipo P):** el SubTotal y Total se leen del Complemento de Pagos 2.0
(`pago20:Totales`), NO del comprobante (que en REPs siempre es `$0`).

---

## 🔧 Variables de entorno

```env
# Entorno
NODE_ENV=production

# Motor SAT = SatGo: API Key PERMANENTE (imprescindible). Ver SATGO.md.
SATGO_API_KEY=<api-key-permanente>
# (alternativa) token del portal para que la app cree la key sola:
# SATGO_PORTAL_TOKEN=<token-portal>

# Sesiones (generar uno aleatorio único). Se guardan en SQLite (sobreviven a reinicios).
SESSION_SECRET=<hex-64-chars>

# Disco persistente (Render: /var/data)
DATA_DIR=/var/data
UPLOADS_DIR=/var/data/efirmas

# Temporal para XMLs (se borra solo el día 1)
TEMP_XML_PATH=/tmp/temp2xml

# Puente a NEXO (altas y pagos de IVA aparecen en NEXO → Facturación). Opcional.
NEXO_API_URL=https://gdm-almacen-backend.onrender.com/api/v1
NEXO_IVA_TOKEN=<= IVA_INTEGRACION_TOKEN del backend de NEXO>

# Escapes (déjalos SIN poner en operación normal):
#   COOKIE_SECURE=false  → solo si Cloudflare está en modo Flexible y el login no deja entrar
#   VENTANA_OFF=true     → desactiva la ventana día 2→fin, para probar cualquier día
```

---

## 🌐 Despliegue (Render.com)

### Plan actual
- **Starter** ($7 USD/mes) — sin auto-sleep
- **Disco persistente 1 GB** ($0.25 USD/mes) — montado en `/var/data`

### Build & Run
```yaml
Root Directory:  iva
Build Command:   npm install --production
Start Command:   node server.js
```

### Subdominio
- Custom Domain: `iva.hcgm.com.mx`
- DNS: CNAME → `gdm-iva.onrender.com`
- SSL: Let's Encrypt automático (Render)

---

## 🔐 Seguridad

| Componente | Implementación |
|---|---|
| Contraseñas de app | bcrypt salt 12 |
| Contraseña e.firma | AES-256-GCM (clave derivada de SESSION_SECRET) |
| Archivos .cer / .key | en disco persistente, NO expuestos públicamente |
| Token SAT | solo en RAM (~4.5 min), se invalida al detectar ataque |
| Rate limit login | 5 intentos / 15 min → bloqueo IP 30 min |
| Rate limit SAT | 10 req / min |
| HTTPS | Let's Encrypt vía Render |
| Cookies sesión | httpOnly + secure + sameSite=lax; store en SQLite (`session-store.js`) |

---

## 📅 Flujo mensual

| Día del mes | Comportamiento |
|---|---|
| Día 1 | Consulta **cerrada**. 00:05 (hora MX) → **limpieza automática** de los XML del mes anterior |
| Día 2 al último | **Sistema activo**: los clientes consultan su IVA del mes en curso |

La ventana (**día 2 → último del mes**) vive en `src/ventana.js` (`dentroDeVentana()`); el aviso
del login sale del mismo módulo (`TEXTO_VENTANA`). `VENTANA_OFF=true` la desactiva para pruebas.
La limpieza del día 1 está en `src/scheduler/tasks.js` (cron `5 0 1 * *`, hora de México).

**Mes que se descarga:** del día 1 al día anterior (ayer) del mes en curso, en hora de México.

---

## 👥 Acceso

| Rol | URL | Quién |
|---|---|---|
| Cliente | https://iva.hcgm.com.mx/login | Cada cliente con sus credenciales |
| Administrador | https://iva.hcgm.com.mx/admin/login | Solo personal de GDM |

---

## 🛠️ Desarrollo local

```bash
git clone https://github.com/anbeor29-oss/GDM_IVA.git
cd GDM_IVA/iva
npm install
cp .env.example .env
# Editar .env con valores locales
node server.js
# Abrir http://127.0.0.1:3500/login
```

---

## 📝 Licencia

Software propietario de **Grupo GDM High Consulting México**.
Uso exclusivo de clientes contratados.

---

*Última actualización: 2026-10-30*
