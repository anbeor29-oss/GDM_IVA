# GDM IVA — Portal de Consulta de IVA SAT

> Aplicación web para que los clientes de **Grupo GDM High Consulting México**
> consulten su IVA mensual descargando CFDIs directamente del SAT con su e.firma.

**Producción:** https://iva.hcgm.com.mx
**Repo:** https://github.com/anbeor29-oss/GDM_IVA

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
- **SQLite (better-sqlite3)** — BD local con admin y clientes
- **`@nodecfdi/sat-ws-descarga-masiva`** — cliente oficial SAT
- **node-forge** — manejo de e.firma (X.509 + RSA)
- **express-session** — sesiones HTTP cifradas
- **helmet + express-rate-limit** — seguridad HTTP
- **node-cron** — tareas programadas (limpieza día 28)
- **fast-xml-parser** — parseo de CFDIs

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
│   │   └── database.js    ← SQLite + cifrado AES-256-GCM
│   ├── sat/
│   │   ├── download.js    ← Cliente SAT con @nodecfdi (job en background)
│   │   └── parser.js      ← Reglas fiscales LIVA
│   ├── security/
│   │   ├── rateLimiter.js ← Anti-DOS y bloqueo de IPs
│   │   └── attackHandler.js
│   ├── scheduler/
│   │   └── tasks.js       ← Limpieza automática día 28
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

# Sesiones (generar uno aleatorio único)
SESSION_SECRET=<hex-64-chars>

# Disco persistente (Render: /var/data)
DATA_DIR=/var/data
UPLOADS_DIR=/var/data/efirmas

# Temporal para XMLs (se borra solo)
TEMP_XML_PATH=/tmp/temp2xml
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
| Cookies sesión | httpOnly + secure + sameSite=lax |

---

## 📅 Flujo mensual

| Día del mes | Comportamiento |
|---|---|
| 1 al 9 | Acceso bloqueado (modo producción): "Disponible a partir del día 10" |
| 10 al 28 | Sistema activo: los clientes pueden consultar su IVA |
| Día 28 | 23:59 hrs (zona MX) → limpieza automática de XMLs |
| 29 al fin de mes | Solo admin disponible |

**Mes que se descarga:** del día 1 al día anterior (ayer) del mes en curso.

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

*Última actualización: 2026-06-11*
