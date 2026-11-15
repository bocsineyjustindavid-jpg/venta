'use strict';
// Todo el contenido dinámico se inserta con textContent (nunca innerHTML) para evitar XSS.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };

  let config = { currency: 'USD' };
  let products = [];
  let csrf = null;
  let cart = [];

  /* ---------- API ---------- */
  async function getCsrf() {
    if (!csrf) csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()).token;
    return csrf;
  }
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    if ((opts.method || 'GET') !== 'GET') headers['X-CSRF-Token'] = await getCsrf();
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 403) csrf = null;
    if (!r.ok) throw new Error(data.error || 'Ocurrió un error.');
    return data;
  }

  const fmt = (cents) => new Intl.NumberFormat('es', { style: 'currency', currency: config.currency }).format(cents / 100);
  const say = (node, msg, ok) => { node.textContent = msg; node.className = 'form-msg ' + (ok ? 'ok' : 'err'); };

  /* ---------- carrito (solo ids/tallas/cantidades; el precio lo calcula el servidor) ---------- */
  function loadCart() {
    try {
      const raw = JSON.parse(localStorage.getItem('cart') || '[]');
      cart = Array.isArray(raw) ? raw.filter((i) => Number.isInteger(i.id) && Number.isInteger(i.qty) && typeof i.size === 'string').slice(0, 30) : [];
    } catch (_) { cart = []; }
  }
  const saveCart = () => { try { localStorage.setItem('cart', JSON.stringify(cart)); } catch (_) {} };

  function addToCart(p, size) {
    const line = cart.find((i) => i.id === p.id && i.size === size);
    const inCart = cart.filter((i) => i.id === p.id).reduce((a, i) => a + i.qty, 0);
    if (inCart >= p.stock || inCart >= 10) return toast('Ya tienes el máximo disponible de esta prenda.');
    if (line) line.qty += 1; else cart.push({ id: p.id, size, qty: 1 });
    saveCart(); renderCart(); openCart();
  }

  function renderCart() {
    const lines = $('#cart-lines');
    lines.replaceChildren();
    cart = cart.filter((i) => products.some((p) => p.id === i.id));
    let total = 0, count = 0;
    for (const item of cart) {
      const p = products.find((x) => x.id === item.id);
      total += p.price_cents * item.qty; count += item.qty;
      const thumb = el('div', { class: 'thumb' }, p.image ? el('img', { src: p.image, alt: '', loading: 'lazy' }) : null);
      const change = (d) => {
        item.qty += d;
        if (item.qty <= 0) cart = cart.filter((i) => i !== item);
        const tot = cart.filter((i) => i.id === p.id).reduce((a, i) => a + i.qty, 0);
        if (tot > p.stock || item.qty > 10) item.qty -= d;
        saveCart(); renderCart();
      };
      lines.append(el('div', { class: 'cart-line' }, thumb,
        el('div', {},
          el('div', { class: 't', text: p.name }),
          el('div', { class: 'muted', text: `Talla ${item.size} · ${fmt(p.price_cents)}` }),
          el('div', { class: 'qty' },
            el('button', { type: 'button', 'aria-label': 'Quitar uno', onclick: () => change(-1), text: '−' }),
            el('span', { text: String(item.qty) }),
            el('button', { type: 'button', 'aria-label': 'Agregar uno', onclick: () => change(1), text: '+' }))),
        el('strong', { text: fmt(p.price_cents * item.qty) })));
    }
    $('#cart-count').textContent = String(count);
    $('#cart-empty').hidden = cart.length > 0;
    $('#cart-total-wrap').hidden = cart.length === 0;
    $('#checkout-form').hidden = cart.length === 0;
    $('#cart-total').textContent = fmt(total);
  }

  const drawer = $('#drawer'), overlay = $('#overlay');
  function openCart() { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); overlay.hidden = false; }
  function closeCart() { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); overlay.hidden = true; }
  $('#open-cart').addEventListener('click', openCart);
  $('#close-cart').addEventListener('click', closeCart);
  overlay.addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCart(); });

  function toast(msg) {
    const n = $('#notice'); n.textContent = msg; n.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { n.hidden = true; }, 6000);
    n.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- catálogo ---------- */
  function productCard(p) {
    const out = p.stock <= 0;
    const sel = el('select', { 'aria-label': `Talla de ${p.name}` }, p.sizes.map((s) => el('option', { value: s, text: s })));
    const pic = el('div', { class: 'pic' },
      p.image ? el('img', { src: p.image, alt: p.name, loading: 'lazy' }) : el('span', { text: p.name.charAt(0).toUpperCase() }),
      p.is_new ? el('span', { class: 'tag', text: 'Nuevo' }) : null,
      out ? el('span', { class: 'tag out', text: 'Agotado' }) : null);
    return el('article', { class: 'product' }, pic,
      el('div', { class: 'info' },
        el('span', { class: 'cat', text: p.category }),
        el('h3', { text: p.name }),
        p.description ? el('p', { class: 'desc', text: p.description }) : null,
        el('span', { class: 'price', text: fmt(p.price_cents) }),
        el('span', { class: 'stock' + (p.stock <= 3 ? ' low' : ''), text: out ? 'Sin existencias' : p.stock <= 3 ? `¡Últimas ${p.stock}!` : 'Disponible' }),
        el('div', { class: 'buy' }, sel,
          el('button', { class: 'btn', type: 'button', disabled: out, onclick: () => addToCart(p, sel.value), text: out ? 'Agotado' : 'Agregar' }))));
  }

  function renderProducts() {
    const q = $('#search').value.trim().toLowerCase();
    const cat = $('#category').value;
    const list = products.filter((p) => (!cat || p.category === cat) && (!q || (p.name + ' ' + p.description + ' ' + p.category).toLowerCase().includes(q)));
    $('#grid-all').replaceChildren(...list.map(productCard));
    $('#empty').hidden = list.length > 0;
    const news = products.filter((p) => p.is_new && p.stock > 0).slice(0, 8);
    $('#grid-new').replaceChildren(...news.map(productCard));
    $('#nuevos').hidden = news.length === 0;
  }

  function fillCategories() {
    const sel = $('#category');
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '', text: 'Todas las categorías' }),
      ...[...new Set(products.map((p) => p.category))].sort().map((c) => el('option', { value: c, text: c })));
    sel.value = cur;
  }

  /* ---------- reseñas ---------- */
  async function loadReviews() {
    const list = await api('/api/reviews');
    const box = $('#reviews');
    box.replaceChildren(...(list.length ? list.map((r) =>
      el('article', { class: 'review' },
        el('div', { class: 'stars', 'aria-label': `${r.rating} de 5 estrellas`, text: '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) }),
        el('p', { text: r.comment }),
        el('div', { class: 'who', text: r.name }))) : [el('p', { class: 'empty', text: 'Aún no hay reseñas. ¡Sé la primera persona en opinar!' })]));
  }

  function setupStars() {
    const wrap = $('#stars-input'); const input = $('#review-form [name=rating]');
    const paint = (n) => [...wrap.children].forEach((b, i) => b.classList.toggle('on', i < n));
    for (let i = 1; i <= 5; i++) {
      wrap.append(el('button', { type: 'button', 'aria-label': `${i} estrellas`, onclick: () => { input.value = String(i); paint(i); }, text: '★' }));
    }
    paint(5);
  }

  /* ---------- formularios ---------- */
  function handleForm(form, url, mapper, after) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('.form-msg', form); const btn = $('button[type=submit]', form);
      if (!form.checkValidity()) { form.reportValidity(); return; }
      btn.disabled = true;
      try {
        const res = await api(url, { method: 'POST', body: mapper(new FormData(form)) });
        say(msg, res.message || 'Enviado.', true); form.reset(); after && after();
      } catch (err) { say(msg, err.message, false); } finally { btn.disabled = false; }
    });
  }
  const formObj = (fd) => Object.fromEntries(fd.entries());
  handleForm($('#review-form'), '/api/reviews', formObj, () => { $('#review-form [name=rating]').value = '5'; });
  handleForm($('#contact-form'), '/api/contact', formObj);

  /* ---------- pago ---------- */
  async function checkout(provider, btn) {
    const form = $('#checkout-form'); const msg = $('#checkout-msg');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    btn.disabled = true; say(msg, 'Redirigiendo a la pasarela de pago segura…', true);
    try {
      const res = await api(`/api/checkout/${provider}`, { method: 'POST', body: { ...formObj(new FormData(form)), items: cart } });
      location.assign(res.url);
    } catch (err) { say(msg, err.message, false); btn.disabled = false; }
  }
  $('#pay-stripe').addEventListener('click', (e) => checkout('stripe', e.currentTarget));
  $('#pay-paypal').addEventListener('click', (e) => checkout('paypal', e.currentTarget));

  /* ---------- arranque ---------- */
  async function init() {
    loadCart();
    try {
      config = await api('/api/config');
      document.title = `${config.storeName} · Ropa en línea`;
      $('#brand').textContent = config.storeName; $('#foot-name').textContent = config.storeName;
      $('#pay-stripe').hidden = !config.stripe; $('#pay-paypal').hidden = !config.paypal;
      $('#pay-missing').hidden = config.stripe || config.paypal;
      const wa = $('#wa-link');
      if (config.whatsapp) {
        wa.href = `https://wa.me/${encodeURIComponent(config.whatsapp)}?text=${encodeURIComponent('Hola, tengo una consulta sobre la tienda.')}`;
        wa.hidden = false;
      } else $('#wa-missing').hidden = false;
      products = await api('/api/products');
      fillCategories(); renderProducts(); renderCart();
      await loadReviews();
    } catch (err) { toast('No se pudo cargar la tienda. Intenta recargar.'); }
    setupStars();
    $('#search').addEventListener('input', renderProducts);
    $('#category').addEventListener('change', renderProducts);
    const p = new URLSearchParams(location.search);
    if (p.get('cancelado')) toast('El pago fue cancelado. Tu carrito sigue guardado.');
    if (p.get('error')) toast('Hubo un problema con el pago. Si se te cobró, escríbenos.');
  }
  init();
})();
