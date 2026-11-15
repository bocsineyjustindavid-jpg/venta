'use strict';
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const validator = require('validator');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const SqliteStore = require('./sessionStore');
const pay = require('./payments');

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const STORE_NAME = (process.env.STORE_NAME || 'Mi Tienda de Ropa').slice(0, 60);
const WHATSAPP = String(process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '').slice(0, 15);
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- utilidades ---------- */
const httpErr = (status, msg) => Object.assign(new Error(msg), { status, expose: true });
const clean = (s, max) =>
  String(s ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const bool = (v) => v === true || v === '1' || v === 'true' || v === 'on';

function sessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) return process.env.SESSION_SECRET;
  const f = path.join(__dirname, 'data', 'session.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

function seedAdmin() {
  db.get('SELECT COUNT(*) as c FROM admins', (err, row) => {
    if (err || (row && row.c > 0)) return;
    const user = clean(process.env.ADMIN_USER || 'admin', 40);
    let pass = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!pass || pass.length < 12) { pass = crypto.randomBytes(12).toString('base64url'); generated = true; }
    
    db.run('INSERT OR IGNORE INTO admins (username, password_hash) VALUES (?, ?)', [user, bcrypt.hashSync(pass, 12)], function(err) {
      if (!err && this.changes > 0) {
        console.log('\n=== ADMINISTRADOR CREADO ===');
        console.log('Usuario     :', user);
        if (generated) console.log('Contraseña :', pass, '  (guárdala y cámbiala desde el panel; no se mostrará de nuevo)');
        else console.log('Contraseña : la definida en ADMIN_PASSWORD (quítala del .env después del primer arranque)');
        console.log('============================\n');
      }
    });
  });
}
seedAdmin();

const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);

/* ---------- app y cabeceras de seguridad ---------- */
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

if (PROD) {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(301, BASE_URL + req.originalUrl)));
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      ...(PROD ? { upgradeInsecureRequests: [] } : {}),
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: PROD ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
  next();
});

const limiter = (windowMs, limit, message) => rateLimit({
  windowMs, limit, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: message || 'Demasiadas solicitudes, intenta más tarde.' }),
});

app.use(limiter(15 * 60 * 1000, 600));

/* ---------- webhook de Stripe (cuerpo crudo, ANTES de json y sesión) ---------- */
/* ---------- webhook de Stripe (adaptado para sqlite3 estándar) ---------- */
const markPaid = (publicId, expectedCents, callback) => {
  db.serialize(() => {
    db.run('BEGIN TRANSACTION;', (err) => {
      if (err) return callback ? callback(err) : console.error(err);

      // 1. Buscar la orden
      db.get('SELECT * FROM orders WHERE public_id = ?', [publicId], (err, o) => {
        if (err || !o || o.status !== 'pendiente') {
          db.run('ROLLBACK;');
          return callback ? callback(err || new Error('Orden no válida')) : null;
        }

        // 2. Validar el monto
        // 2. Validar el monto
if (expectedCents != null && expectedCents !== o.total_cents) {
  db.run("UPDATE orders SET status = 'revisar' WHERE id = ?", [o.id], (err) => {
    if (err) {
      db.run('ROLLBACK;');
      return callback ? callback(err) : null;
    }
    db.run('COMMIT;', (err) => {
      if (err) return callback ? callback(err) : null;
      return callback ? callback(null, { status: 'revisar' }) : null;
    });
  });
  return;
}

        // 3. Procesar los ítems y actualizar stock
        let items;
        try {
          items = JSON.parse(o.items_json);
        } catch (e) {
          db.run('ROLLBACK;');
          return callback ? callback(e) : null;
        }

        let ok = true;
        let processed = 0;

        if (items.length === 0) {
          finalizeOrder(o.id, true, callback);
          return;
        }

        items.forEach((l) => {
          db.run(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
            [l.qty, l.id, l.qty],
            function (err) {
              if (err || this.changes === 0) {
                ok = false;
              }
              processed++;
              if (processed === items.length) {
                finalizeOrder(o.id, ok, callback);
              }
            }
          );
        });
      });
    });
  });
};

function finalizeOrder(orderId, ok, callback) {
  const newStatus = ok ? 'pagado' : 'revisar';
  db.run('UPDATE orders SET status = ? WHERE id = ?', [newStatus, orderId], (err) => {
    if (err) {
      db.run('ROLLBACK;');
      return callback ? callback(err) : null;
    }
    db.run('COMMIT;', (err) => {
      if (err) return callback ? callback(err) : null;
      if (callback) callback(null, { status: newStatus });
    });
  });
}

app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  if (!pay.stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = pay.stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (_) {
    return res.status(400).send('firma inválida');
  }
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const s = event.data.object;
    if (s.payment_status === 'paid' && s.metadata?.order_id) {
      const o = db.prepare('SELECT currency FROM orders WHERE public_id = ?').get(s.metadata.order_id);
      if (o && o.currency.toLowerCase() === String(s.currency).toLowerCase()) markPaid(s.metadata.order_id, s.amount_total);
    }
  }
  res.json({ received: true });
});

/* ---------- parsers, sesión y CSRF ---------- */
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(hpp());

app.use(session({
  name: PROD ? '__Host-sid' : 'sid',
  secret: sessionSecret(),
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 2 * 60 * 60 * 1000, path: '/' },
}));

app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) throw 0; } catch (_) { return res.status(403).json({ error: 'Origen no permitido' }); }
  }
  const t = req.get('x-csrf-token');
  const s = req.session && req.session.csrf;
  if (!t || !s || t.length !== s.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s))) {
    return res.status(403).json({ error: 'Token CSRF inválido. Recarga la página.' });
  }
  next();
});

app.get('/api/csrf', (req, res) => {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString('hex');
  res.set('Cache-Control', 'no-store').json({ token: req.session.csrf });
});

/* ---------- API pública ---------- */
const pubProduct = (p) => ({
  id: p.id, name: p.name, description: p.description, price_cents: p.price_cents,
  category: p.category, sizes: p.sizes.split(',').map((s) => s.trim()).filter(Boolean),
  stock: p.stock, image: p.image ? `/uploads/${p.image}` : null, is_new: !!p.is_new,
});

app.get('/api/config', (req, res) => {
  res.json({
    storeName: STORE_NAME, whatsapp: WHATSAPP, currency: pay.currency,
    stripe: !!pay.stripe, paypal: pay.paypalEnabled,
  });
});

app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY is_new DESC, id DESC LIMIT 500').all();
  res.json(rows.map(pubProduct));
});

app.get('/api/reviews', (req, res) => {
  res.json(db.prepare('SELECT id, name, rating, comment, created_at FROM reviews WHERE approved = 1 ORDER BY id DESC LIMIT 60').all());
});

app.post('/api/reviews', limiter(60 * 60 * 1000, 5, 'Has enviado muchas reseñas. Intenta más tarde.'), (req, res) => {
  const b = req.body || {};
  if (clean(b.website, 100)) return res.json({ ok: true }); // honeypot
  const name = clean(b.name, 60);
  const comment = clean(b.comment, 1000);
  const rating = Number(b.rating);
  if (name.length < 2 || comment.length < 3 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw httpErr(400, 'Revisa tu nombre, calificación (1-5) y comentario.');
  }
  db.prepare('INSERT INTO reviews (name, rating, comment) VALUES (?, ?, ?)').run(name, rating, comment);
  res.status(201).json({ ok: true, message: '¡Gracias! Tu reseña se publicará cuando sea aprobada.' });
});

app.post('/api/contact', limiter(60 * 60 * 1000, 8, 'Has enviado muchos mensajes. Intenta más tarde.'), (req, res) => {
  const b = req.body || {};
  if (clean(b.website, 100)) return res.json({ ok: true }); // honeypot
  const name = clean(b.name, 80);
  const email = clean(b.email, 254).toLowerCase();
  const phone = clean(b.phone, 30);
  const kind = ['duda', 'reseña', 'pedido', 'otro'].includes(b.kind) ? b.kind : 'duda';
  const body = clean(b.message, 2000);
  if (name.length < 2 || !validator.isEmail(email) || body.length < 3) throw httpErr(400, 'Revisa nombre, correo y mensaje.');
  if (phone && !/^[0-9+()\-\s]{6,30}$/.test(phone)) throw httpErr(400, 'Teléfono inválido.');
  db.prepare('INSERT INTO messages (name, email, phone, kind, body) VALUES (?, ?, ?, ?, ?)').run(name, email, phone || null, kind, body);
  res.status(201).json({ ok: true, message: 'Mensaje enviado. ¡Te responderemos pronto!' });
});

/* ---------- checkout ---------- */
function priceCart(items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw httpErr(400, 'Carrito inválido.');
  const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const lines = []; const qtyById = {}; let total = 0;
  for (const it of items) {
    const id = Number(it?.id); const qty = Number(it?.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 10) throw httpErr(400, 'Carrito inválido.');
    const p = getP.get(id);
    if (!p) throw httpErr(400, 'Un producto del carrito ya no está disponible.');
    const sizes = p.sizes.split(',').map((s) => s.trim());
    const size = clean(it.size, 20);
    if (!sizes.includes(size)) throw httpErr(400, `Talla inválida para ${p.name}.`);
    qtyById[id] = (qtyById[id] || 0) + qty;
    if (qtyById[id] > p.stock) throw httpErr(409, `No hay existencias suficientes de ${p.name}.`);
    lines.push({ id, name: p.name, size, qty, unit_cents: p.price_cents });
    total += p.price_cents * qty;
  }
  return { lines, total };
}

function parseCustomer(b) {
  const c = {
    name: clean(b.name, 100), email: clean(b.email, 254).toLowerCase(),
    phone: clean(b.phone, 30), address: clean(b.address, 300),
  };
  if (c.name.length < 2 || !validator.isEmail(c.email) || !/^[0-9+()\-\s]{6,30}$/.test(c.phone) || c.address.length < 5) {
    throw httpErr(400, 'Completa correctamente nombre, correo, teléfono y dirección.');
  }
  return c;
}

function createOrder(cust, cart, provider) {
  const publicId = crypto.randomBytes(12).toString('hex');
  db.prepare(`INSERT INTO orders (public_id, customer_name, email, phone, address, items_json, total_cents, currency, provider)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(publicId, cust.name, cust.email, cust.phone, cust.address, JSON.stringify(cart.lines), cart.total, pay.currency, provider);
  return db.prepare('SELECT * FROM orders WHERE public_id = ?').get(publicId);
}

const checkoutLimit = limiter(60 * 60 * 1000, 20, 'Demasiados intentos de pago. Intenta más tarde.');

app.post('/api/checkout/stripe', checkoutLimit, async (req, res) => {
  if (!pay.stripe) throw httpErr(503, 'El pago con tarjeta aún no está configurado.');
  const cust = parseCustomer(req.body || {});
  const cart = priceCart(req.body?.items);
  const order = createOrder(cust, cart, 'stripe');
  const s = await pay.stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: cust.email,
    client_reference_id: order.public_id,
    metadata: { order_id: order.public_id },
    line_items: cart.lines.map((l) => ({
      quantity: l.qty,
      price_data: { currency: pay.currency.toLowerCase(), unit_amount: l.unit_cents, product_data: { name: `${l.name} (${l.size})` } },
    })),
    success_url: `${BASE_URL}/gracias.html?o=${order.public_id}`,
    cancel_url: `${BASE_URL}/?cancelado=1`,
  });
  db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(s.id, order.id);
  res.json({ url: s.url });
});

app.post('/api/checkout/paypal', checkoutLimit, async (req, res) => {
  if (!pay.paypalEnabled) throw httpErr(503, 'PayPal aún no está configurado.');
  const cust = parseCustomer(req.body || {});
  const cart = priceCart(req.body?.items);
  const order = createOrder(cust, cart, 'paypal');
  const pp = await pay.paypalCreateOrder(order, `${BASE_URL}/api/paypal/return`, `${BASE_URL}/?cancelado=1`);
  db.prepare('UPDATE orders SET provider_ref = ? WHERE id = ?').run(pp.id, order.id);
  res.json({ url: pp.approveUrl });
});

app.get('/api/paypal/return', async (req, res) => {
  const token = String(req.query.token || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(token)) return res.redirect('/?error=1');
  const o = db.prepare("SELECT * FROM orders WHERE provider = 'paypal' AND provider_ref = ?").get(token);
  if (!o) return res.redirect('/?error=1');
  try {
    if (o.status === 'pendiente') {
      const cap = await pay.paypalCapture(token);
      if (cap.completed && cap.currency === o.currency && cap.value === pay.money(o.total_cents)) markPaid(o.public_id, null);
      else db.prepare("UPDATE orders SET status = 'revisar' WHERE id = ? AND status = 'pendiente'").run(o.id);
    }
  } catch (e) { console.error('PayPal capture:', e.message); }
  res.redirect(`/gracias.html?o=${o.public_id}`);
});

app.get('/api/orders/:publicId', (req, res) => {
  if (!/^[a-f0-9]{24}$/.test(req.params.publicId)) throw httpErr(404, 'No encontrado');
  const o = db.prepare('SELECT status FROM orders WHERE public_id = ?').get(req.params.publicId);
  if (!o) throw httpErr(404, 'No encontrado');
  res.set('Cache-Control', 'no-store').json({ status: o.status });
});

/* ---------- administrador ---------- */
const failures = new Map(); // bloqueo por usuario
const LOCK_MS = 15 * 60 * 1000;

app.post('/api/admin/login', limiter(15 * 60 * 1000, 10, 'Demasiados intentos. Espera 15 minutos.'), async (req, res) => {
  const username = clean(req.body?.username, 40);
  const password = String(req.body?.password ?? '').slice(0, 200);
  const f = failures.get(username);
  if (f && f.count >= 5 && Date.now() - f.last < LOCK_MS) throw httpErr(429, 'Cuenta bloqueada temporalmente.');
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const ok = await bcrypt.compare(password, admin ? admin.password_hash : DUMMY_HASH);
  if (!admin || !ok) {
    failures.set(username, { count: (f && Date.now() - f.last < LOCK_MS ? f.count : 0) + 1, last: Date.now() });
    throw httpErr(401, 'Usuario o contraseña incorrectos.');
  }
  failures.delete(username);
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Error de sesión' });
    req.session.adminId = admin.id;
    req.session.csrf = crypto.randomBytes(32).toString('hex');
    res.json({ ok: true, csrf: req.session.csrf, username: admin.username });
  });
});

const requireAdmin = (req, res, next) => (req.session?.adminId ? next() : res.status(401).json({ error: 'No autorizado' }));
const adminApi = express.Router();
adminApi.use(requireAdmin, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

adminApi.get('/me', (req, res) => {
  const a = db.prepare('SELECT username FROM admins WHERE id = ?').get(req.session.adminId);
  res.json({ username: a?.username, csrf: req.session.csrf });
});

adminApi.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie(PROD ? '__Host-sid' : 'sid'); res.json({ ok: true }); });
});

adminApi.post('/password', async (req, res) => {
  const cur = String(req.body?.current ?? ''); const next = String(req.body?.next ?? '');
  if (next.length < 12 || next.length > 200) throw httpErr(400, 'La nueva contraseña debe tener al menos 12 caracteres.');
  const a = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (!(await bcrypt.compare(cur, a.password_hash))) throw httpErr(401, 'Contraseña actual incorrecta.');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(next, 12), a.id);
  res.json({ ok: true });
});

/* productos */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1, fields: 20 } });

function detectImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
function saveImage(file) {
  const ext = detectImage(file.buffer);
  if (!ext) throw httpErr(400, 'Imagen no válida (solo JPG, PNG o WEBP de hasta 3 MB).');
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer, { mode: 0o644 });
  return name;
}
function removeImage(name) {
  if (name && /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(name)) fs.rm(path.join(UPLOAD_DIR, name), { force: true }, () => {});
}
function parseProduct(b) {
  const name = clean(b.name, 120);
  const price = String(b.price ?? '').trim();
  const sizes = clean(b.sizes || 'Única', 120).split(',').map((s) => s.trim()).filter(Boolean);
  const stock = Number(b.stock);
  if (name.length < 2) throw httpErr(400, 'Nombre muy corto.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(price) || Number(price) <= 0) throw httpErr(400, 'Precio inválido.');
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw httpErr(400, 'Existencias inválidas.');
  if (!sizes.length || sizes.length > 12 || sizes.some((s) => !/^[\p{L}\p{N} .\-\/]{1,10}$/u.test(s))) throw httpErr(400, 'Tallas inválidas (separadas por coma, máx. 10 caracteres cada una).');
  return {
    name, description: clean(b.description, 2000), price_cents: Math.round(Number(price) * 100),
    category: clean(b.category || 'General', 60) || 'General', sizes: sizes.join(','), stock,
    is_new: bool(b.is_new) ? 1 : 0, active: bool(b.active) ? 1 : 0,
  };
}
const adminProduct = (p) => ({ ...pubProduct(p), active: !!p.active, price: (p.price_cents / 100).toFixed(2), sizesText: p.sizes });

adminApi.get('/products', (req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(adminProduct)));

adminApi.post('/products', upload.single('image'), (req, res) => {
  const p = parseProduct(req.body || {});
  const image = req.file ? saveImage(req.file) : null;
  const r = db.prepare('INSERT INTO products (name, description, price_cents, category, sizes, stock, image, is_new, active) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(p.name, p.description, p.price_cents, p.category, p.sizes, p.stock, image, p.is_new, p.active);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

adminApi.put('/products/:id', upload.single('image'), (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!old) throw httpErr(404, 'Producto no encontrado');
  const p = parseProduct(req.body || {});
  let image = old.image;
  if (req.file) image = saveImage(req.file);
  db.prepare('UPDATE products SET name=?, description=?, price_cents=?, category=?, sizes=?, stock=?, image=?, is_new=?, active=? WHERE id=?')
    .run(p.name, p.description, p.price_cents, p.category, p.sizes, p.stock, image, p.is_new, p.active, id);
  if (req.file) removeImage(old.image);
  res.json({ ok: true });
});

adminApi.delete('/products/:id', (req, res) => {
  const old = db.prepare('SELECT image FROM products WHERE id = ?').get(Number(req.params.id));
  if (!old) throw httpErr(404, 'Producto no encontrado');
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
  removeImage(old.image);
  res.json({ ok: true });
});

/* reseñas */
adminApi.get('/reviews', (req, res) => res.json(db.prepare('SELECT * FROM reviews ORDER BY approved ASC, id DESC LIMIT 500').all()));
adminApi.patch('/reviews/:id', (req, res) => {
  db.prepare('UPDATE reviews SET approved = ? WHERE id = ?').run(bool(req.body?.approved) ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});
adminApi.delete('/reviews/:id', (req, res) => { db.prepare('DELETE FROM reviews WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

/* mensajes */
adminApi.get('/messages', (req, res) => res.json(db.prepare('SELECT * FROM messages ORDER BY is_read ASC, id DESC LIMIT 500').all()));
adminApi.patch('/messages/:id', (req, res) => {
  db.prepare('UPDATE messages SET is_read = ? WHERE id = ?').run(bool(req.body?.is_read) ? 1 : 0, Number(req.params.id));
  res.json({ ok: true });
});
adminApi.delete('/messages/:id', (req, res) => { db.prepare('DELETE FROM messages WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

/* pedidos */
adminApi.get('/orders', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500').all();
  res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined })));
});
adminApi.patch('/orders/:id', (req, res) => {
  const st = req.body?.status;
  if (!['pendiente', 'pagado', 'enviado', 'entregado', 'cancelado', 'revisar'].includes(st)) throw httpErr(400, 'Estado inválido');
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(st, Number(req.params.id));
  res.json({ ok: true });
});

adminApi.get('/stats', (req, res) => {
  res.json({
    unreadMessages: db.prepare('SELECT COUNT(*) c FROM messages WHERE is_read = 0').get().c,
    pendingReviews: db.prepare('SELECT COUNT(*) c FROM reviews WHERE approved = 0').get().c,
    paidOrders: db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'pagado'").get().c,
  });
});

app.use('/api/admin', adminApi);

/* ---------- estáticos ---------- */
app.use('/admin', (req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }); next(); });
app.use('/uploads', express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny', maxAge: '7d', setHeaders: (r) => r.setHeader('Content-Disposition', 'inline') }));
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', index: 'index.html', maxAge: PROD ? '1h' : 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

/* ---------- errores ---------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'La imagen supera 3 MB.' : 'Archivo no válido.' });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Solicitud inválida.' });
  const status = err.expose ? err.status : (err.status && err.status < 500 ? err.status : 500);
  if (!err.expose && status === 500) console.error(err);
  res.status(status).json({ error: err.expose || status < 500 ? err.message : 'Error interno del servidor.' });
});

app.listen(PORT, HOST, () => console.log(`Tienda lista en ${BASE_URL}  (panel: ${BASE_URL}/admin/)`));
