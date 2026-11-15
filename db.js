'use strict';
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dir = path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, 'tienda.db');

// Abrir la base de datos de manera compatible
const db = new sqlite3.Database(file, (err) => {
  if (err) {
    console.error('Error al abrir la base de datos:', err.message);
  } else {
    console.log('Conectado a la base de datos SQLite.');
  }
});

// Configurar pragmas y tablas de forma secuencial
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA foreign_keys = ON;');
  db.run('PRAGMA secure_delete = ON;');

  try { 
    fs.chmodSync(file, 0o600); 
  } catch (_) { 
    /* en Windows no aplica */ 
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
      description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
      price_cents INTEGER NOT NULL CHECK (price_cents > 0 AND price_cents <= 100000000),
      category TEXT NOT NULL DEFAULT 'General' CHECK (length(category) BETWEEN 1 AND 60),
      sizes TEXT NOT NULL DEFAULT 'Única',
      stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      image TEXT,
      is_new INTEGER NOT NULL DEFAULT 1 CHECK (is_new IN (0,1)),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 60),
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL CHECK (length(comment) BETWEEN 3 AND 1000),
      approved INTEGER NOT NULL DEFAULT 0 CHECK (approved IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('duda','reseña','pedido','otro')),
      body TEXT NOT NULL CHECK (length(body) BETWEEN 3 AND 2000),
      is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      customer_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT NOT NULL,
      items_json TEXT NOT NULL,
      total_cents INTEGER NOT NULL CHECK (total_cents > 0),
      currency TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('stripe','paypal')),
      provider_ref TEXT,
      status TEXT NOT NULL DEFAULT 'pendiente'
        CHECK (status IN ('pendiente','pagado','enviado','entregado','cancelado','revisar')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
    CREATE INDEX IF NOT EXISTS idx_orders_ref ON orders(provider_ref);
  `, (err) => {
    if (err) {
      console.error('Error al crear las tablas:', err.message);
    }
  });
});

module.exports = db;