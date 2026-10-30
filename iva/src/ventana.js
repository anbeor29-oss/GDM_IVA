'use strict';
/**
 * Ventana de consulta — UNA sola definición para toda la app.
 *
 * LA REGLA
 * La consulta de IVA va del DÍA 2 al ÚLTIMO del mes. El día 1 queda fuera a
 * propósito: ese día el scheduler (scheduler/tasks.js, cron '5 0 1 * *') borra
 * los XML del mes anterior y el mes nuevo todavía no tiene movimientos.
 *
 * POR QUÉ AQUÍ
 * Estaba repetida en auth.js y en dashboard.js, y se desincronizaron: una tenía
 * MODO_PRODUCCION=true y la otra false, y encima el texto del login decía otro
 * rango ("del 10 al 29"). Con una sola definición ya no pueden decir cosas
 * distintas. El texto de la ventana vive aquí también (TEXTO_VENTANA) para que
 * los mensajes salgan del mismo lugar que la regla.
 *
 * ESCAPE PARA PRUEBAS
 * VENTANA_OFF=true desactiva la restricción (cualquier día), para probar fuera
 * de la ventana sin tocar código. En producción se deja sin esa variable.
 */
const MODO_PRODUCCION = process.env.VENTANA_OFF !== 'true';

/** ¿Hoy (o `fecha`) cae dentro de la ventana de consulta? Día 2 … último del mes. */
function dentroDeVentana(fecha = new Date()) {
  if (!MODO_PRODUCCION) return true;
  return fecha.getDate() >= 2;
}

/** Texto para los mensajes de "fuera de ventana". */
const TEXTO_VENTANA = 'del día 2 al último día de cada mes';

module.exports = { MODO_PRODUCCION, dentroDeVentana, TEXTO_VENTANA };
