'use strict';
/**
 * SqliteSessionStore — guarda las sesiones del admin en la MISMA base SQLite
 * (que en Render vive en el disco persistente), NO en memoria.
 *
 * POR QUÉ
 * express-session, sin `store`, usa su MemoryStore por defecto: las sesiones
 * viven en la RAM del proceso. En Render el proceso se reinicia en cada deploy
 * y se duerme por inactividad, así que esa RAM se borra: el admin se sale solo
 * y, peor, las acciones del panel (que van por fetch: marcar pagado, prender
 * Excel) reciben un 302 al login en vez de ejecutarse → "no hace nada".
 * Guardando la sesión en disco, sobrevive a los reinicios.
 *
 * Es un store mínimo (get/set/destroy/touch) sobre better-sqlite3 — que el
 * proyecto YA usa—, así que no agrega dependencias ni compilaciones nativas.
 */
const { Store } = require('express-session');

const DOS_HORAS = 2 * 60 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS sesiones (
      sid    TEXT PRIMARY KEY,
      expira INTEGER NOT NULL,
      data   TEXT NOT NULL
    )`);
    this._get = db.prepare('SELECT data, expira FROM sesiones WHERE sid = ?');
    this._set = db.prepare(`INSERT INTO sesiones (sid, expira, data) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET expira = excluded.expira, data = excluded.data`);
    this._del = db.prepare('DELETE FROM sesiones WHERE sid = ?');
    this._touch = db.prepare('UPDATE sesiones SET expira = ? WHERE sid = ?');
    this._purge = db.prepare('DELETE FROM sesiones WHERE expira < ?');

    const purgar = () => { try { this._purge.run(Date.now()); } catch (_) {} };
    purgar();                                   // limpia expiradas al arrancar
    this._timer = setInterval(purgar, 60 * 60 * 1000);
    if (this._timer.unref) this._timer.unref(); // no impide que el proceso termine
  }

  _expira(sess) {
    const ms = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : DOS_HORAS;
    return Date.now() + ms;
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid);
      if (!row) return cb(null, null);
      if (row.expira < Date.now()) { this._del.run(sid); return cb(null, null); }
      return cb(null, JSON.parse(row.data));
    } catch (e) { return cb(e); }
  }

  set(sid, sess, cb) {
    try { this._set.run(sid, this._expira(sess), JSON.stringify(sess)); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this._del.run(sid); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }

  touch(sid, sess, cb) {
    try { this._touch.run(this._expira(sess), sid); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }
}

module.exports = SqliteSessionStore;
