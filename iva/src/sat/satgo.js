'use strict';
/**
 * Cliente de SatGo para la DESCARGA MASIVA de CFDI (sustituye al motor @nodecfdi).
 *
 * Flujo oficial del SAT, pero por REST vía SatGo (3 pasos), usando la e.firma del
 * usuario (igual que antes) subida como multipart:
 *   1) POST /api/v2/SatWebService/solicita   → IdSolicitud
 *   2) POST /api/v2/SatWebService/verifica   → estado (3 = lista) + idsPaquetes[]
 *   3) POST /api/v2/SatWebService/descarga   → paqueteBase64 (ZIP con los XML)
 *
 * Auth: la API Key PERMANENTE va en el entorno (SATGO_API_KEY). Con ella se pide un
 * JWT corto (POST /api/Auth/token?key=...) que se cachea. Cada llamada lleva
 * Authorization: Bearer <JWT> + header RFC. (El Secret/CIEC no se usa aquí: la
 * e.firma viaja en el cuerpo multipart.)
 *
 * Node 18+: FormData/Blob son globales y axios 1.x los serializa como multipart.
 */
const fs    = require('fs');
const axios = require('axios');
const { log } = require('../security/attackHandler');

const BASE = (process.env.SATGO_BASE_URL || 'https://api.sat-go.com').replace(/\/+$/, '');
const T = 60000;

let _jwt = null;
let _jwtExp = 0;

/** JWT de SatGo (cacheado). SATGO_API_KEY (permanente) o, si no hay, canjea
 *  SATGO_PORTAL_TOKEN por la API Key una sola vez (CreateKey). */
async function getJwt() {
  const now = Date.now();
  if (_jwt && _jwtExp > now + 60000) return _jwt;

  let key = (process.env.SATGO_API_KEY || '').trim();
  if (!key) {
    const portal = (process.env.SATGO_PORTAL_TOKEN || '').trim();
    if (!portal) throw new Error('Falta SATGO_API_KEY (o SATGO_PORTAL_TOKEN) en el entorno del servidor.');
    const r = await axios.post(`${BASE}/api/v1/Users/CreateKey`, {}, {
      headers: { Authorization: `Bearer ${portal}` }, timeout: T, validateStatus: () => true });
    if (r.status < 200 || r.status >= 300) throw new Error(`SatGo CreateKey respondió ${r.status}: ${textoErr(r)}`);
    key = r.data && (r.data.key || r.data.apiKey || r.data.apikey);
    if (!key) throw new Error('SatGo CreateKey no devolvió una API Key reconocible.');
  }

  const r = await axios.post(`${BASE}/api/Auth/token?key=${encodeURIComponent(key)}`, {}, {
    timeout: T, validateStatus: () => true });
  if (r.status < 200 || r.status >= 300) {
    const pista = r.status === 401
      ? ' — la SATGO_API_KEY no es válida: debe ser la API Key PERMANENTE de SatGo (la que da CreateKey), no el token del portal; revisa también que no tenga espacios ni comillas.'
      : '';
    throw new Error(`SatGo Auth/token respondió ${r.status}${pista} ${textoErr(r)}`.trim());
  }
  const jwt = (typeof r.data === 'string')
    ? r.data
    : (r.data && (r.data.token || r.data.access_token || r.data.accessToken
        || (r.data.tokens && r.data.tokens.access && r.data.tokens.access.value)));
  if (!jwt) throw new Error('SatGo no devolvió un token de acceso.');
  let exp = now + 4 * 60000;
  try { const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8')); if (p && p.exp) exp = p.exp * 1000; } catch (_) {}
  _jwt = jwt; _jwtExp = exp;
  log('SatGo: JWT obtenido');
  return jwt;
}

/** multipart con la e.firma (lo piden solicita/verifica/descarga). */
function efirmaForm(efirma) {
  const form = new FormData();
  form.append('Certificado', new Blob([fs.readFileSync(efirma.cerPath)]), 'efirma.cer');
  form.append('llavePrivada', new Blob([fs.readFileSync(efirma.keyPath)]), 'efirma.key');
  form.append('Contrasena', String(efirma.password || ''));
  return form;
}

function textoErr(r) {
  try { return typeof r.data === 'string' ? r.data.slice(0, 300) : JSON.stringify(r.data).slice(0, 300); }
  catch (_) { return ''; }
}

async function postMultipart(pathUrl, rfc, efirma, params) {
  const jwt = await getJwt();
  return axios.post(`${BASE}${pathUrl}`, efirmaForm(efirma), {
    params,
    headers: { Authorization: `Bearer ${jwt}`, RFC: rfc },
    timeout: T, validateStatus: () => true,
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
}

/** Paso 1 — solicita la descarga masiva de CFDI (XML) de un periodo.
 *  tipo: 'emitidos' | 'recibidos'. estadoComprobante: 'Vigente' (excluye cancelados). */
async function solicita(rfc, efirma, { tipo, fechaIni, fechaFin, estadoComprobante = 'Vigente' }) {
  const r = await postMultipart('/api/v2/SatWebService/solicita', rfc, efirma, {
    tipo, fecha_inicial: fechaIni, fecha_final: fechaFin, tipoBusqueda: 'CFDI', estadoComprobante });
  if (r.status < 200 || r.status >= 300) throw new Error(`solicita ${tipo} → ${r.status}: ${textoErr(r)}`);
  const d = r.data || {};
  if (d.success === false) throw new Error(`solicita ${tipo}: ${d.errorMessage || 'rechazada por el SAT'}`);
  const id = d.idSolicitud || d.IdSolicitud || d.idsolicitud;
  if (!id) throw new Error(`solicita ${tipo}: el SAT no devolvió IdSolicitud (${textoErr(r)})`);
  return id;
}

/** Paso 2 — verifica el estado de una solicitud. estado 3 = terminada. */
async function verifica(rfc, efirma, idSolicitud) {
  const r = await postMultipart('/api/v2/SatWebService/verifica', rfc, efirma, { IdSolicitud: idSolicitud });
  if (r.status < 200 || r.status >= 300) throw new Error(`verifica → ${r.status}: ${textoErr(r)}`);
  const d = r.data || {};
  return {
    estado: Number(d.estadoSolicitud != null ? d.estadoSolicitud : (d.EstadoSolicitud != null ? d.EstadoSolicitud : 0)),
    cod: Number(d.codEstatus != null ? d.codEstatus : (d.CodEstatus != null ? d.CodEstatus : 0)),
    paquetes: d.idsPaquetes || d.IdsPaquetes || [],
    mensaje: d.errorMessage || '',
  };
}

/** Paso 3 — descarga un paquete (ZIP en base64). */
async function descarga(rfc, efirma, idPaquete) {
  const r = await postMultipart('/api/v2/SatWebService/descarga', rfc, efirma, { IdPaquete: idPaquete });
  if (r.status < 200 || r.status >= 300) throw new Error(`descarga → ${r.status}: ${textoErr(r)}`);
  const d = r.data || {};
  return d.paqueteBase64 || d.PaqueteBase64 || '';
}

/** Consulta SÍNCRONA de CFDI por e.firma (FIEL): UNA sola llamada que devuelve los
 *  comprobantes con su XML en base64 (campo `content`), sin el flujo asíncrono
 *  solicita/verifica/descarga. tipo: 'emitidos' | 'recibidos'.
 *  Devuelve { comprobantes, requestId, count }. Si el SAT topa el volumen suele
 *  devolver sólo `requestId` (modo metadata) en vez de los comprobantes. */
async function consultaFac(rfc, efirma, { tipo, fechaIni, fechaFin }) {
  const jwt = await getJwt();
  const r = await axios.post(`${BASE}/api/v2/Consultar/facfiel`, efirmaForm(efirma), {
    params: {
      'api-version': '2',
      tipo,                        // emitidos | recibidos
      tipoBusqueda: 1,             // 1 = por rango de fechas
      estatusFactura: 1,           // -1 Todos, 0 Cancelados, 1 Vigentes (recibidos lo exige)
      fecha_inicial: fechaIni,     // yyyy-MM-dd HH:mm:ss
      fecha_final: fechaFin,
      descargaComprobantes: true,  // incluye el XML (content) en la respuesta
      descargaPdfs: false,
    },
    headers: { Authorization: `Bearer ${jwt}`, RFC: rfc },
    timeout: 180000,               // síncrono, pero la respuesta puede ser grande
    validateStatus: () => true,
    maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`facfiel ${tipo} → ${r.status}: ${textoErr(r)}`);
  const d = r.data || {};
  if (d.success === false || d.Success === false) {
    throw new Error(`facfiel ${tipo}: ${d.errorMessage || d.ErrorMessage || 'rechazada por el SAT'}`);
  }
  const comprobantes = d.comprobantes || d.Comprobantes || [];
  const requestId = d.requestId || d.RequestId || null;
  const count = (d.count != null ? d.count : (d.Count != null ? d.Count : comprobantes.length));
  return { comprobantes, requestId, count };
}

/** Igual que consultaFac pero NO lanza: devuelve un resumen de la respuesta CRUDA de
 *  SatGo para diagnóstico (status, success, count, requestId, nComprobantes, llaves).
 *  Sirve para ver por qué una consulta devuelve 0 sin tener acceso a los logs. */
async function consultaFacDebug(rfc, efirma, { tipo, fechaIni, fechaFin, estatus }) {
  let jwt;
  try { jwt = await getJwt(); } catch (e) { return { paso: 'jwt', error: e.message }; }
  const estatusFactura = (estatus != null && estatus !== '') ? Number(estatus) : 1;
  let r;
  try {
    r = await axios.post(`${BASE}/api/v2/Consultar/facfiel`, efirmaForm(efirma), {
      params: { 'api-version': '2', tipo, tipoBusqueda: 1, estatusFactura, fecha_inicial: fechaIni, fecha_final: fechaFin, descargaComprobantes: true, descargaPdfs: false },
      headers: { Authorization: `Bearer ${jwt}`, RFC: rfc },
      timeout: 180000, validateStatus: () => true, maxBodyLength: Infinity, maxContentLength: Infinity,
    });
  } catch (e) { return { paso: 'http', error: e.message }; }
  const esObj = r.data && typeof r.data === 'object';
  const d = esObj ? r.data : {};
  const comps = d.comprobantes || d.Comprobantes || [];
  const primero = comps[0] || null;
  return {
    estatusFactura,
    status: r.status,
    dataTipo: typeof r.data,
    dataKeys: esObj ? Object.keys(d).slice(0, 30) : null,
    success: d.success != null ? d.success : d.Success,
    errorMessage: d.errorMessage || d.ErrorMessage || null,
    count: d.count != null ? d.count : (d.Count != null ? d.Count : null),
    requestId: d.requestId || d.RequestId || null,
    nComprobantes: comps.length,
    primerComprobanteKeys: primero ? Object.keys(primero).slice(0, 40) : null,
    primerTieneContent: primero ? !!(primero.content || primero.Content) : null,
    cuerpoBreve: (typeof r.data === 'string') ? r.data.slice(0, 600) : undefined,
  };
}

module.exports = { getJwt, solicita, verifica, descarga, consultaFac, consultaFacDebug };
