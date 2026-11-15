'use strict';
(async () => {
  const msg = document.getElementById('msg');
  const id = new URLSearchParams(location.search).get('o') || '';
  if (!/^[a-f0-9]{24}$/.test(id)) { msg.textContent = 'Enlace no válido.'; return; }
  for (let i = 0; i < 8; i++) {
    try {
      const { status } = await (await fetch(`/api/orders/${id}`)).json();
      if (status === 'pagado' || status === 'enviado' || status === 'entregado') {
        try { localStorage.removeItem('cart'); } catch (_) {}
        msg.textContent = 'Tu pago fue confirmado. Pronto nos pondremos en contacto para coordinar la entrega.';
        return;
      }
      if (status === 'revisar') { msg.textContent = 'Recibimos tu pago y estamos revisando el pedido. Te escribiremos pronto.'; return; }
    } catch (_) { /* reintenta */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  msg.textContent = 'Aún no vemos la confirmación del pago. Si se te cobró, escríbenos y lo resolvemos enseguida.';
})();
