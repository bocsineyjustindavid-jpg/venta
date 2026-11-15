'use strict';
// Almacén de sesiones en SQLite (la memoria por defecto de express-session no es apta para producción).
const session = require('express-session');
const db = require('./db');

const getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
const setStmt = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires');
const delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
const cleanStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');

class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => cleanStmt.run(Date.now()), 10 * 60 * 1000).unref();
  }
  _exp(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + 2 * 3600 * 1000;
  }
  get(sid, cb) {
    try {
      const row = getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { setStmt.run(sid, JSON.stringify(sess), this._exp(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { touchStmt.run(this._exp(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
}
module.exports = SqliteStore;
