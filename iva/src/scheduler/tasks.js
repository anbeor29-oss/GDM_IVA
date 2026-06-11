'use strict';
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { log } = require('../security/attackHandler');

const TEMP_XML_PATH = process.env.TEMP_XML_PATH || 'C:\\temp2xml';

/**
 * Elimina recursivamente el contenido de un directorio sin borrar el directorio raíz
 */
function vaciarDirectorio(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const itemPath = path.join(dir, item);
    const stat = fs.statSync(itemPath);
    if (stat.isDirectory()) {
      count += vaciarDirectorio(itemPath);   // acumular archivos borrados en subcarpetas
      try { fs.rmdirSync(itemPath); } catch (_) {}
    } else {
      fs.unlinkSync(itemPath);
      count++;
    }
  }
  return count;
}

/**
 * Tarea principal: ejecutar el día 30 de cada mes a las 23:59
 * Vacía C:\temp2xml\ eliminando todos los XMLs del mes
 */
function iniciarScheduler() {
  // Día 30 a las 23:59 de cada mes
  cron.schedule('59 23 30 * *', () => {
    log('SCHEDULER: Iniciando limpieza automática de XMLs (día 30)...');
    try {
      const eliminados = vaciarDirectorio(TEMP_XML_PATH);
      log(`SCHEDULER: Limpieza completada. ${eliminados} archivos eliminados de ${TEMP_XML_PATH}`);
    } catch (e) {
      log(`SCHEDULER ERROR en limpieza: ${e.message}`);
    }
  }, { timezone: 'America/Mexico_City' });

  log('Scheduler iniciado. Limpieza programada para el día 30 de cada mes a las 23:59');
}

module.exports = { iniciarScheduler, vaciarDirectorio };
