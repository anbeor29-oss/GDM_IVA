'use strict';
const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');
const path = require('path');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,   // false: mantiene "002" como string, no lo convierte a nÃºmero 2
  allowBooleanAttributes: true
});

// â”€â”€ Extrae IVA del nodo Impuestos principal (I+PUE y E) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function extraerIVAImpuestos(comp) {
  const impuestos = comp['cfdi:Impuestos'] || comp['Impuestos'] || {};
  const traslados = impuestos['cfdi:Traslados']?.['cfdi:Traslado']
    || impuestos['Traslados']?.['Traslado'] || [];
  const arr = Array.isArray(traslados) ? traslados : [traslados];
  let iva = 0;
  for (const t of arr) {
    if (!t) continue;
    if (String(t['@_Impuesto'] || '') !== '002') continue;
    const importe = parseFloat(t['@_Importe'] || 0);
    if (importe > 0) {
      iva += importe;
    } else {
      const base = parseFloat(t['@_Base'] || comp['@_SubTotal'] || 0);
      const tasa = parseFloat(t['@_TasaOCuota'] || 0);
      iva += base * tasa;
    }
  }
  return iva;
}

// â”€â”€ Extrae IVA y montos del Complemento de Pagos 2.0 (Tipo P / REP) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Retorna { iva, base, monto } donde:
//   iva   = IVA efectivamente cobrado/pagado en el pago
//   base  = base gravable (TotalTrasladosBaseIVA16 + IVA8)
//   monto = monto total del pago (MontoTotalPagos)
function extraerDatosREP(complemento) {
  // Soporte para Complemento de Pagos 2.0 (pago20) y 1.0 (pago10 / pago)
  const pagos = complemento['pago20:Pagos'] || complemento['pago10:Pagos']
              || complemento['Pagos'] || {};

  // Forma rÃ¡pida: leer Totales directamente (disponible en pago20)
  const totales = pagos['pago20:Totales'] || pagos['pago10:Totales']
                || pagos['Totales'] || {};

  const iva16   = parseFloat(totales['@_TotalTrasladosImpuestoIVA16'] || 0);
  const iva8    = parseFloat(totales['@_TotalTrasladosImpuestoIVA8']  || 0);
  const base16  = parseFloat(totales['@_TotalTrasladosBaseIVA16']     || 0);
  const base8   = parseFloat(totales['@_TotalTrasladosBaseIVA8']      || 0);
  const monto   = parseFloat(totales['@_MontoTotalPagos']             || 0);

  if (iva16 + iva8 > 0) {
    return { iva: iva16 + iva8, base: base16 + base8, monto };
  }

  // Fallback: sumar por cada DoctoRelacionado (pago10 o cuando no hay Totales)
  const pagoRaw  = pagos['pago20:Pago'] || pagos['pago10:Pago'] || pagos['Pago'] || [];
  const pagosArr = Array.isArray(pagoRaw) ? pagoRaw : [pagoRaw];
  let ivaTotal = 0, baseTotal = 0, montoTotal = 0;

  for (const pago of pagosArr) {
    if (!pago) continue;
    montoTotal += parseFloat(pago['@_Monto'] || 0);

    const doctosRaw = pago['pago20:DoctoRelacionado'] || pago['pago10:DoctoRelacionado']
                    || pago['DoctoRelacionado'] || [];
    const doctosArr = Array.isArray(doctosRaw) ? doctosRaw : [doctosRaw];

    for (const docto of doctosArr) {
      if (!docto) continue;
      const impDR   = docto['pago20:ImpuestosDR'] || docto['pago10:ImpuestosDR']
                    || docto['ImpuestosDR'] || {};
      const traslDR = impDR['pago20:TrasladosDR'] || impDR['pago10:TrasladosDR']
                    || impDR['TrasladosDR'] || {};
      const tRaw    = traslDR['pago20:TrasladoDR'] || traslDR['pago10:TrasladoDR']
                    || traslDR['TrasladoDR'] || [];
      const tArr    = Array.isArray(tRaw) ? tRaw : [tRaw];
      for (const t of tArr) {
        if (!t) continue;
        if (String(t['@_ImpuestoDR'] || '') === '002') {
          ivaTotal  += parseFloat(t['@_ImporteDR'] || 0);
          baseTotal += parseFloat(t['@_BaseDR']    || 0);
        }
      }
    }
  }

  return { iva: ivaTotal, base: baseTotal, monto: montoTotal };
}

// â”€â”€ Parser principal de un CFDI individual â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseCFDI(xmlContent, tipo) {
  let doc;
  try { doc = parser.parse(xmlContent); } catch (_) { return null; }

  const comp = doc['cfdi:Comprobante'] || doc['Comprobante'];
  if (!comp) return null;

  const tipoComp   = comp['@_TipoDeComprobante'] || '';
  const metodoPago = comp['@_MetodoPago'] || '';

  // Tipos que nunca generan IVA efectivo
  if (tipoComp === 'T' || tipoComp === 'N') return null;

  // I + PPD: el IVA se difiere â€” se reconoce cuando el pagador emite el REP (Tipo P)
  if (tipoComp === 'I' && metodoPago === 'PPD') return null;

  const emisor      = comp['cfdi:Emisor']      || comp['Emisor']      || {};
  const receptor    = comp['cfdi:Receptor']    || comp['Receptor']    || {};
  const complemento = comp['cfdi:Complemento'] || comp['Complemento'] || {};
  const timbre      = complemento['tfd:TimbreFiscalDigital']
                    || complemento['TimbreFiscalDigital'] || {};

  let ivaTraslado = 0;
  let subtotalCalc = Math.round(parseFloat(comp['@_SubTotal'] || 0) * 100) / 100;
  let totalCalc    = Math.round(parseFloat(comp['@_Total']    || 0) * 100) / 100;

  if (tipoComp === 'P') {
    // REP: IVA y montos vienen del Complemento de Pagos, no del Comprobante
    // (comp[@SubTotal] y comp[@Total] son siempre "0" en los REPs por spec CFDI 4.0)
    const rep = extraerDatosREP(complemento);
    ivaTraslado  = rep.iva;
    subtotalCalc = Math.round(rep.base  * 100) / 100;   // base gravable del pago
    totalCalc    = Math.round(rep.monto * 100) / 100;   // monto total del pago
  } else {
    // I + PUE  y  E (Egreso / Nota de crÃ©dito): IVA del nodo Impuestos principal
    ivaTraslado = extraerIVAImpuestos(comp);
  }

  if (ivaTraslado === 0) return null;

  // Egreso (nota de crÃ©dito / devoluciÃ³n): el IVA RESTA al acumulado del mes
  if (tipoComp === 'E') ivaTraslado = -Math.abs(ivaTraslado);

  // Etiqueta legible para el dashboard
  const etiquetaTipo = tipoComp === 'P' ? 'REP'
    : tipoComp === 'E' ? 'N.CrÃ©d'
    : `${tipoComp}/${metodoPago || 'PUE'}`;

  return {
    uuid:           timbre['@_UUID'] || '',
    tipo,
    tipoComp,
    etiquetaTipo,
    fecha:          (comp['@_Fecha'] || '').substring(0, 10),
    serie:          comp['@_Serie'] || '',
    folio:          String(comp['@_Folio'] || ''),
    rfcEmisor:      emisor['@_Rfc']    || emisor['@_RFC']    || '',
    nombreEmisor:   emisor['@_Nombre'] || '',
    rfcReceptor:    receptor['@_Rfc']  || receptor['@_RFC']  || '',
    nombreReceptor: receptor['@_Nombre'] || '',
    subtotal: subtotalCalc,
    iva:      Math.round(ivaTraslado * 100) / 100,
    total:    totalCalc,
    moneda:   comp['@_Moneda'] || 'MXN'
  };
}

function parseCarpeta(dir, tipo) {
  if (!fs.existsSync(dir)) return [];
  const xmls = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.xml'));
  const resultados = [];

  for (const f of xmls) {
    try {
      const cfdi = parseCFDI(fs.readFileSync(path.join(dir, f), 'utf8'), tipo);
      if (cfdi) resultados.push(cfdi);
    } catch (_) {}
  }

  resultados.sort((a, b) => {
    const d = a.fecha.localeCompare(b.fecha);
    return d !== 0 ? d : a.folio.localeCompare(b.folio, undefined, { numeric: true });
  });

  return resultados;
}

function calcularIVA(tempXmlPath, rfc) {
  const now  = new Date();
  // Usar SIEMPRE el mes en curso (evita mostrar mes anterior el dÃ­a 1)
  // El dÃ­a 1: mes en curso estÃ¡ vacÃ­o â†’ muestra tablas vacÃ­as (correcto)
  // Del dÃ­a 2 en adelante: muestra CFDIs del mes en curso
  const mes  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const base = path.join(tempXmlPath, rfc, mes);

  const emitidos  = parseCarpeta(path.join(base, 'emitidos'),  'emitido');
  const recibidos = parseCarpeta(path.join(base, 'recibidos'), 'recibido');

  // IVA Trasladado  = cobrado a clientes  (emitidos: I/PUE + REPs emitidos)
  // IVA Acreditable = pagado a proveedores (recibidos: I/PUE + REPs recibidos)
  // Los Egresos (N.CrÃ©d) tienen iva negativo â†’ restan automÃ¡ticamente
  const ivaTraslado    = Math.round(emitidos.reduce( (s, c) => s + c.iva, 0) * 100) / 100;
  const ivaAcreditable = Math.round(recibidos.reduce((s, c) => s + c.iva, 0) * 100) / 100;
  const resultado      = Math.round((ivaTraslado - ivaAcreditable) * 100) / 100;

  return { emitidos, recibidos, ivaTraslado, ivaAcreditable, resultado, aCargo: resultado >= 0 };
}

module.exports = { parseCFDI, parseCarpeta, calcularIVA };
