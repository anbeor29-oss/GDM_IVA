'use strict';
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { log } = require('../security/attackHandler');

// Fallback multiplataforma: en Linux /tmp/temp2xml, en Windows C:\temp2xml
const DEFAULT_TEMP = process.platform === 'win32' ? 'C:\\temp2xml' : '/tmp/temp2xml';
const TEMP_XML_PATH = process.env.TEMP_XML_PATH || DEFAULT_TEMP;

/**
 * Elimina recursivamente el contenido de un directorio sin borrar el directorio raíz.
 * Devuelve cuántos archivos borró (incluyendo subdirectorios).
 */
function vaciarDirectorio(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const item of fs.readdirSync(dir)) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    if (stat.isDirectory()) {
      count += vaciarDirectorio(itemPath);
      try { fs.rmdirSync(itemPath); } catch (_) {}
    } else {
      try { fs.unlinkSync(itemPath); count++; } catch (_) {}
    }
  }
  return count;
}

/** Ejecuta la limpieza de XMLs. Pública para invocarla también desde una ruta admin. */
function limpiarXmls() {
  try {
    const eliminados = vaciarDirectorio(TEMP_XML_PATH);
    log(`SCHEDULER: Limpieza completada. ${eliminados} archivos eliminados de ${TEMP_XML_PATH}`);
    return { ok: true, eliminados, ruta: TEMP_XML_PATH };
  } catch (e) {
    log(`SCHEDULER ERROR en limpieza: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Registra los cron jobs. La limpieza corre el DÍA 1 de cada mes a las 00:05 (CDMX):
 * entra el mes nuevo -> se borra todo lo del mes anterior y el mes en curso se vuelve a
 * descargar desde cero (día 1 -> hoy). Antes corría a fin de mes (día 28-31), lo que
 * borraba el mes en curso a media utilidad.
 */
function iniciarScheduler() {
  const tz = 'America/Mexico_City';

  cron.schedule('5 0 1 * *', () => {
    log('SCHEDULER: Limpieza del día 1 (entra mes nuevo)...');
    limpiarXmls();
  }, { timezone: tz });

  const nowMx = new Date().toLocaleString('es-MX', { timeZone: tz });
  log('Scheduler iniciado.');
  log(`  -> Hora actual (México): ${nowMx}`);
  log(`  -> Ruta a limpiar: ${TEMP_XML_PATH}`);
  log('  -> Limpieza: día 1 de cada mes a las 00:05 (CDMX)');
}

module.exports = { iniciarScheduler, vaciarDirectorio, limpiarXmls };
