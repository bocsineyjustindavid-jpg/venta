'use strict';
// Panel de administración. Todo se pinta con textContent (sin innerHTML) y cada cambio envía token CSRF.
(() => {
  const app = document.getElementById('app');
  let csrf = null;
  let tab = 'products';
  let currency = 'USD';

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  const fmt = (c) => new Intl.NumberFormat('es', { style: 'currency', currency }).format(c / 100);
  const when = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('es');

  async function api(path, { method = 'GET', body, form } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
    let payload;
    if (form) payload = form;
    else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`/api/admin${path}`, { method, headers, body: payload, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/login') { renderLogin(); throw new Error('Sesión expirada'); }
    if (!r.ok) throw new Error(data.error || 'Error');
    return data;
  }

  async function boot() {
    try {
      currency = (await (await fetch('/api/config')).json()).currency || 'USD';
      const me = await api('/me');
      csrf = me.csrf;
      renderPanel(me.username);
    } catch (_) { renderLogin(); }
  }

  /* ---------- login ---------- */
  function renderLogin() {
    const msg = el('p', { class: 'form-msg err', role: 'alert' });
    const form = el('form', { class: 'card form login', autocomplete: 'on' },
      el('h1', { text: 'Administrador' }),
      el('label', {}, 'Usuario', el('input', { name: 'username', required: true, autocomplete: 'username', maxlength: 40 })),
      el('label', {}, 'Contraseña', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password', maxlength: 200 })),
      el('button', { class: 'btn', type: 'submit', text: 'Entrar' }), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      // Necesitamos un token CSRF de sesión anónima antes de iniciar sesión.
      try {
        csrf = (await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()).token;
        const r = await api('/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
        csrf = r.csrf;
        renderPanel(r.username);
      } catch (err) { msg.textContent = err.message; }
    });
    app.replaceChildren(form);
  }

  /* ---------- panel ---------- */
  async function renderPanel(username) {
    const stats = await api('/stats').catch(() => ({}));
    const tabs = [
      ['products', 'Productos', 0], ['orders', 'Pedidos', stats.paidOrders], ['messages', 'Mensajes', stats.unreadMessages],
      ['reviews', 'Reseñas', stats.pendingReviews], ['account', 'Cuenta', 0],
    ];
    const content = el('div');
    const bar = el('div', { class: 'admin-bar' },
      el('h1', { class: 'grow', text: 'Panel de la tienda' }),
      el('span', { class: 'muted', text: `Sesión: ${username}` }),
      el('a', { class: 'btn ghost sm', href: '/', text: 'Ver tienda' }),
      el('button', { class: 'btn ghost sm', type: 'button', text: 'Salir', onclick: async () => { await api('/logout', { method: 'POST' }); renderLogin(); } }));
    const nav = el('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, n]) =>
      el('button', { type: 'button', role: 'tab', class: tab === id ? 'on' : '', onclick: () => { tab = id; renderPanel(username); } },
        label, n ? el('span', { class: 'n', text: String(n) }) : null)));
    app.replaceChildren(el('div', { class: 'admin' }, bar, nav, content));
    const views = { products: viewProducts, orders: viewOrders, messages: viewMessages, reviews: viewReviews, account: viewAccount };
    try { await views[tab](content, () => renderPanel(username)); } catch (err) { content.textContent = err.message; }
  }

  /* ---------- productos ---------- */
  async function viewProducts(root, refresh) {
    const list = await api('/products');
    let editing = null;
    const form = el('form', { class: 'card form', novalidate: true });
    const msg = el('p', { class: 'form-msg', role: 'status' });

    function fillForm(p) {
      editing = p;
      form.replaceChildren(
        el('h2', { text: p ? `Editar: ${p.name}` : 'Agregar prenda nueva' }),
        el('div', { class: 'pform' },
          el('label', {}, 'Nombre', el('input', { name: 'name', required: true, maxlength: 120, value: p?.name || '' })),
          el('label', {}, `Precio (${currency})`, el('input', { name: 'price', required: true, inputmode: 'decimal', placeholder: '25.00', value: p?.price || '' })),
          el('label', {}, 'Categoría', el('input', { name: 'category', maxlength: 60, placeholder: 'Camisas, Pantalones…', value: p?.category || '' })),
          el('label', {}, 'Tallas (separadas por coma)', el('input', { name: 'sizes', required: true, maxlength: 120, placeholder: 'S, M, L, XL', value: p?.sizesText || '' })),
          el('label', {}, 'Existencias', el('input', { name: 'stock', type: 'number', min: 0, max: 100000, required: true, value: p ? String(p.stock) : '1' })),
          el('label', {}, 'Foto (JPG, PNG o WEBP, máx. 3 MB)', el('input', { name: 'image', type: 'file', accept: 'image/jpeg,image/png,image/webp' })),
          el('label', { class: 'wide' }, 'Descripción', el('textarea', { name: 'description', rows: 3, maxlength: 2000, text: p?.description || '' })),
          el('div', { class: 'checks wide' },
            el('label', {}, el('input', { type: 'checkbox', name: 'is_new', checked: p ? p.is_new : true }), 'Mostrar en "Nuevos"'),
            el('label', {}, el('input', { type: 'checkbox', name: 'active', checked: p ? p.active : true }), 'Visible al público'))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', type: 'submit', text: p ? 'Guardar cambios' : 'Agregar prenda' }),
          p ? el('button', { class: 'btn ghost', type: 'button', text: 'Cancelar', onclick: () => fillForm(null) }) : null),
        msg);
    }
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      fd.set('is_new', form.is_new.checked ? '1' : '0');
      fd.set('active', form.active.checked ? '1' : '0');
      if (!form.image.files.length) fd.delete('image');
      try {
        await api(editing ? `/products/${editing.id}` : '/products', { method: editing ? 'PUT' : 'POST', form: fd });
        refresh();
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
    });
    fillForm(null);

    const rows = list.map((p) => el('div', { class: 'row-card' },
      p.image ? el('img', { class: 'mini', src: p.image, alt: '' }) : el('div', { class: 'mini' }),
      el('div', { class: 'main' },
        el('strong', { text: p.name }), ' ', p.is_new ? el('span', { class: 'pill ok', text: 'Nuevo' }) : null, ' ',
        !p.active ? el('span', { class: 'pill', text: 'Oculto' }) : null,
        el('div', { class: 'meta', text: `${p.category} · ${fmt(p.price_cents)} · Tallas: ${p.sizesText} · Existencias: ${p.stock}` })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost sm', type: 'button', text: 'Editar', onclick: () => { fillForm(p); form.scrollIntoView({ behavior: 'smooth' }); } }),
        el('button', { class: 'btn danger sm', type: 'button', text: 'Eliminar', onclick: async () => {
          if (confirm(`¿Eliminar "${p.name}"? Esta acción no se puede deshacer.`)) { await api(`/products/${p.id}`, { method: 'DELETE' }); refresh(); }
        } }))));
    root.replaceChildren(form, el('h2', { text: `Inventario (${list.length})` }), ...(rows.length ? rows : [el('p', { class: 'empty', text: 'Aún no has agregado prendas.' })]));
  }

  /* ---------- pedidos ---------- */
  async function viewOrders(root, refresh) {
    const list = await api('/orders');
    const states = ['pendiente', 'pagado', 'enviado', 'entregado', 'cancelado', 'revisar'];
    root.replaceChildren(el('h2', { text: `Pedidos (${list.length})` }), ...(list.length ? list.map((o) => el('div', { class: 'row-card' },
      el('div', { class: 'main' },
        el('strong', { text: `${o.customer_name} · ${fmt(o.total_cents)}` }),
        el('div', { class: 'meta', text: `${when(o.created_at)} · ${o.provider} · ${o.email} · ${o.phone}` }),
        el('div', { text: o.address }),
        el('div', { class: 'meta', text: o.items.map((i) => `${i.qty}× ${i.name} (${i.size})`).join(' · ') })),
      el('select', { class: 'status-sel', 'aria-label': 'Estado del pedido', onchange: async (e) => { await api(`/orders/${o.id}`, { method: 'PATCH', body: { status: e.target.value } }); refresh(); } },
        states.map((s) => el('option', { value: s, text: s, ...(s === o.status ? { selected: true } : {}) }))))) : [el('p', { class: 'empty', text: 'Sin pedidos todavía.' })]));
  }

  /* ---------- mensajes ---------- */
  async function viewMessages(root, refresh) {
    const list = await api('/messages');
    root.replaceChildren(el('h2', { text: `Mensajes (${list.length})` }), ...(list.length ? list.map((m) => el('div', { class: 'row-card' + (m.is_read ? '' : ' unread') },
      el('div', { class: 'main' },
        el('strong', { text: m.name }), ' ', el('span', { class: 'pill', text: m.kind }),
        el('div', { class: 'meta', text: `${when(m.created_at)} · ${m.email}${m.phone ? ' · ' + m.phone : ''}` }),
        el('p', { text: m.body })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost sm', type: 'button', text: m.is_read ? 'Marcar sin leer' : 'Marcar leído', onclick: async () => { await api(`/messages/${m.id}`, { method: 'PATCH', body: { is_read: !m.is_read } }); refresh(); } }),
        el('button', { class: 'btn danger sm', type: 'button', text: 'Borrar', onclick: async () => { if (confirm('¿Borrar este mensaje?')) { await api(`/messages/${m.id}`, { method: 'DELETE' }); refresh(); } } })))) : [el('p', { class: 'empty', text: 'No hay mensajes.' })]));
  }

  /* ---------- reseñas ---------- */
  async function viewReviews(root, refresh) {
    const list = await api('/reviews');
    root.replaceChildren(el('h2', { text: `Reseñas y comentarios (${list.length})` }), ...(list.length ? list.map((r) => el('div', { class: 'row-card' + (r.approved ? '' : ' unread') },
      el('div', { class: 'main' },
        el('span', { class: 'stars', text: '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) }), ' ',
        el('strong', { text: r.name }), ' ', el('span', { class: r.approved ? 'pill ok' : 'pill', text: r.approved ? 'Publicada' : 'Pendiente' }),
        el('div', { class: 'meta', text: when(r.created_at) }),
        el('p', { text: r.comment })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn ghost sm', type: 'button', text: r.approved ? 'Ocultar' : 'Aprobar y publicar', onclick: async () => { await api(`/reviews/${r.id}`, { method: 'PATCH', body: { approved: !r.approved } }); refresh(); } }),
        el('button', { class: 'btn danger sm', type: 'button', text: 'Borrar', onclick: async () => { if (confirm('¿Borrar esta reseña?')) { await api(`/reviews/${r.id}`, { method: 'DELETE' }); refresh(); } } })))) : [el('p', { class: 'empty', text: 'No hay reseñas.' })]));
  }

  /* ---------- cuenta ---------- */
  function viewAccount(root) {
    const msg = el('p', { class: 'form-msg', role: 'status' });
    const form = el('form', { class: 'card form login', novalidate: true },
      el('h2', { text: 'Cambiar contraseña' }),
      el('label', {}, 'Contraseña actual', el('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
      el('label', {}, 'Nueva contraseña (mín. 12 caracteres)', el('input', { name: 'next', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' })),
      el('button', { class: 'btn', type: 'submit', text: 'Actualizar' }), msg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/password', { method: 'POST', body: { current: form.current.value, next: form.next.value } });
        msg.textContent = 'Contraseña actualizada.'; msg.className = 'form-msg ok'; form.reset();
      } catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
    });
    root.replaceChildren(form);
  }

  boot();
})();
