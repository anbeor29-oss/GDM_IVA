'use strict';
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { log } = require('../security/attackHandler');

// Fallback multi-plataforma: en Linux usa /tmp/temp2xml, en Windows C:\temp2xml
const DEFAULT_TEMP = process.platform === 'win32' ? 'C:\\temp2xml' : '/tmp/temp2xml';
const TEMP_XML_PATH = process.env.TEMP_XML_PATH || DEFAULT_TEMP;

/**
 * Elimina recursivamente el contenido de un directorio sin borrar el directorio raÃ­z.
 * Retorna la cantidad de archivos borrados (incluyendo subdirectorios).
 */
function vaciarDirectorio(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    if (stat.isDirectory()) {
      count += vaciarDirectorio(itemPath);
      try { fs.rmdirSync(itemPath); } catch (_) {}
    } else {
      try {
        fs.unlinkSync(itemPath);
        count++;
      } catch (_) {}
    }
  }
  return count;
}

/**
 * Ejecuta la limpieza de XMLs y devuelve el resultado.
 * FunciÃ³n pÃºblica para poder invocarla tambiÃ©n desde una ruta admin manual.
 */
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
 * Â¿Es hoy dÃ­a 28, 29, 30 o 31 despuÃ©s de las 23:00 hora MÃ©xico?
 * Sirve como "catch-up" si el proceso se reiniciÃ³ y perdiÃ³ el cron principal.
 */
function esFinDeMes() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
  return now.getDate() >= 28 && now.getHours() >= 23;
}

/**
 * Registra los cron jobs.
 *
 * Estrategia mejorada (v2):
 *   1. Cron principal: dÃ­a 28 a las 23:59 zona MÃ©xico
 *   2. Cron de "catch-up": cada dÃ­a a las 23:59 verifica si es Ãºltimo dÃ­a del mes
 *      â†’ asÃ­ aunque falle el dÃ­a 28 exacto, se ejecuta el 29/30/31
 *   3. Log inicial al arrancar el scheduler con la hora y ruta
 */
function iniciarScheduler() {
  const tz = 'America/Mexico_City';

  // â”€â”€ Job principal: dÃ­a 28 a las 23:59 MÃ©xico â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  cron.schedule('59 23 28 * *', () => {
    log('SCHEDULER: Ejecutando limpieza principal (dÃ­a 28)...');
    limpiarXmls();
  }, { timezone: tz });

  // â”€â”€ Job de catch-up: todos los dÃ­as 29, 30, 31 a las 23:55 hora MÃ©xico â”€â”€â”€â”€
  // Si el mes tiene menos dÃ­as o el proceso se reiniciÃ³, sigue limpiando
  cron.schedule('55 23 29-31 * *', () => {
    log(`SCHEDULER: Ejecutando limpieza catch-up (dÃ­a ${new Date().getDate()})...`);
    limpiarXmls();
  }, { timezone: tz });

  // â”€â”€ Log de inicio con toda la info Ãºtil â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const nowMx = new Date().toLocaleString('es-MX', { timeZone: tz });
  log(`Scheduler iniciado.`);
  log(`  â†’ Hora actual (MÃ©xico): ${nowMx}`);
  log(`  â†’ Ruta a limpiar: ${TEMP_XML_PATH}`);
  log(`  â†’ Job principal: dÃ­a 28 a las 23:59`);
  log(`  â†’ Job catch-up: dÃ­as 29/30/31 a las 23:55`);

  // â”€â”€ Auto-limpieza inicial si el proceso arranca en fin de mes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (esFinDeMes()) {
    log('SCHEDULER: Detectado fin de mes al arrancar â†’ limpieza automÃ¡tica...');
    limpiarXmls();
  }
}

module.exports = { iniciarScheduler, vaciarDirectorio, limpiarXmls };
