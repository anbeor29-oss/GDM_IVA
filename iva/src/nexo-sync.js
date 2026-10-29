'use strict';
/**
 * Puente IVA → NEXO. Avisa a NEXO de cada cliente (alta o compra de créditos) para
 * que aparezca en Súper Admin → Facturación → «IVA (servicio)» y se le pueda
 * facturar desde la emisora que se elija.
 *
 * Variables (servicio `iva` en Render):
 *   NEXO_API_URL   default https://gdm-almacen-backend.onrender.com/api/v1
 *   NEXO_IVA_TOKEN el MISMO valor que IVA_INTEGRACION_TOKEN en gdm-almacen-backend
 *   NEXO_ERP_URL   default https://hcgm.com.mx/erp (a dónde manda el botón «+ Créditos»)
 *
 * Sin NEXO_IVA_TOKEN no hace nada (no rompe el alta ni el panel).
 */
const NEXO_API_URL = (process.env.NEXO_API_URL || 'https://gdm-almacen-backend.onrender.com/api/v1').replace(/\/$/, '');
const NEXO_ERP_URL = (process.env.NEXO_ERP_URL || 'https://hcgm.com.mx/erp').replace(/\/$/, '');

/** Devuelve { ok, companyId?, error? }. Nunca lanza. */
async function sincronizarCliente(u, motivo) {
  const token = process.env.NEXO_IVA_TOKEN;
  if (!token) return { ok: false, error: 'Falta NEXO_IVA_TOKEN: el puente con NEXO está apagado.' };
  if (!u || !u.rfc) return { ok: false, error: 'Cliente sin RFC.' };
  try {
    const r = await fetch(`${NEXO_API_URL}/integracion/iva/cliente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-iva-token': token },
      body: JSON.stringify({
        rfc: u.rfc, nombre: u.nombre, correo: u.username, telefono: u.telefono,
        cp: u.cp, regimen: u.regimen, empresa: u.empresa, motivo: motivo || 'REGISTRO',
        // Anualidad pagada → NEXO lo pasa a «Usuarios reales» con su próximo cobro.
        ...(u.estado === 'ACTIVO' && u.vigencia_fin
          ? { pagadoDesde: u.pagado_desde || null, vigenciaFin: u.vigencia_fin } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.success) return { ok: false, error: j.error || j.message || `NEXO respondió ${r.status}` };
    return { ok: true, companyId: j.data && j.data.companyId };
  } catch (e) {
    return { ok: false, error: 'No se pudo contactar a NEXO: ' + e.message };
  }
}

const urlFacturacionNexo = () => `${NEXO_ERP_URL}/admin/facturacion?panel=IVA`;

module.exports = { sincronizarCliente, urlFacturacionNexo };
