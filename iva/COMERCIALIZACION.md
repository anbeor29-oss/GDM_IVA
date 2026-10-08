# Comercialización del Portal de IVA

> Desde **2026‑10‑07** el portal deja de ser "solo clientes GDM": cualquier prospecto
> puede **autoregistrarse**, probarlo gratis y **pagar** una suscripción anual. La
> **descarga a Excel** es un servicio de pago aparte (incluido en la anualidad).

---

## Dos tipos de usuario

| | `origen = ADMIN` (clientes GDM) | `origen = AUTOREGISTRO` (prospectos) |
|---|---|---|
| Alta | La crea el admin | Autoregistro en `/registro` |
| Consultas | **Sin límite** | **2 pruebas** gratis → luego bloqueado |
| Tras pagar | n/a | `ACTIVO` con vigencia **365 días** |
| Excel | Solo si el admin lo habilita (de pago) | Incluido al pagar la anualidad |

---

## Modelo comercial

- **2 consultas de prueba** gratis al autoregistrarse.
- Al agotarlas → estado **`BLOQUEADO`** (no puede consultar).
- Suscripción **$500 + IVA anual**. Al **"Marcar pagado"** → `ACTIVO` con vigencia de
  **365 días** (contador regresivo); a 0 días se bloquea.
- **Pago manual** (el admin pulsa "Marcar pagado"). *Pendiente: pasarela de pago.*

---

## Columnas en `usuarios` (BD) — migración idempotente

| Columna | Valores | Default |
|---|---|---|
| `estado` | `ACTIVO` · `PRUEBA` · `BLOQUEADO` | `ACTIVO` |
| `origen` | `ADMIN` · `AUTOREGISTRO` | `ADMIN` |
| `pruebas_usadas` / `pruebas_max` | contador de pruebas | `0` / `2` |
| `vigencia_fin` | fecha `YYYY-MM-DD` fin de anualidad | — |
| `must_change_password` | cambio de contraseña obligatorio | `0` |
| `excel_habilitado` | derecho a descargar Excel (de pago) | **`0`** |
| `cp`, `regimen` | datos de facturación del prospecto | — |

---

## Flujo del prospecto

1. `/registro` → captura nombre/RFC/CP/régimen/correo. El **usuario = su correo** y se
   le da una **contraseña temporal en pantalla** (una sola vez).
2. Primer login → **cambiar contraseña** obligatorio.
3. **Configurar e.firma** (se sube una vez; la consulta la requiere).
4. Dashboard: hace sus **2 consultas** de prueba → al agotarlas, `/bloqueado`.
5. El admin **marca pagado** → vuelve a `ACTIVO` 365 días **+ Excel habilitado**.

### Confianza de la e.firma
En `/registro` y en `configurar-efirma` se aclara: la e.firma se usa **solo para
consultar el IVA ante el SAT** en el momento y **no se almacena la información
fiscal** (los CFDI y el cálculo se procesan al instante y se borran).
> Nota técnica: el archivo `.cer`/`.key` sí se guarda **cifrado** en el disco para no
> pedirlo en cada consulta; lo que no se conserva es la información fiscal (CFDI/IVA).

---

## Descarga a Excel = servicio de pago por usuario

- `excel_habilitado` nace en **0 para TODOS** (incluidos los clientes GDM).
- El botón **"⬇ Excel"** del dashboard y la ruta `GET /dashboard/exportar` quedan
  **ocultos/bloqueados** sin el permiso (`/api/estado-cuenta` expone `excel`).
- **Admin** → checkbox **"Excel"** por cliente (`POST /admin/usuarios/:id/excel`).
- `marcarPagado` **enciende** Excel; `bloquearComercial` ("no pagado") lo **apaga**.
- El `.xlsx` se arma sin dependencias nuevas (un `.xlsx` es un ZIP OOXML, vía `adm-zip`):
  detalle de emitidos/recibidos + resumen (trasladado/acreditable/a cargo o a favor).

---

## Panel de administración

- Lista de clientes con **badge de estado** (Cliente GDM / Prueba N/2 / Bloqueado /
  Activo·N días).
- Botones con icono alineados: **✏️ Editar · ⏸️ Desactivar · 🗑️ Eliminar** y, para
  prospectos, **💳 Pagado / 🚫 No pagado**.
- Checkbox **Excel** por cliente.

---

## Pantallas (archivos)

| Archivo | Para qué |
|---|---|
| `views/registro.html` | Alta del prospecto (botón "Crear mi cuenta") |
| `views/registro-exito.html` | Muestra usuario + contraseña temporal |
| `views/cambiar-password-usuario.html` | Cambio de contraseña del primer login |
| `views/configurar-efirma.html` | Subida de e.firma + nota de confianza |
| `views/bloqueado.html` | Prueba agotada / vencido → oferta de pago |
| `public/acceso-denegado.html` | Oferta ($500+IVA/año) + CTA "Crear mi cuenta" |
| `public/login.html` | Enlace grande "¿No eres cliente? Consulta tu IVA aquí" |

---

## Pendientes

- [ ] Pasarela de pago (hoy el admin marca pagado a mano).
- [ ] Reportes históricos (meses anteriores).

---

*Actualizado: 2026‑10‑07*
