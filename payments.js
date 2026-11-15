'use strict';
// Pagos: Stripe Checkout (tarjeta débito/crédito) y PayPal Orders v2.
// Los datos de tarjeta NUNCA pasan por este servidor: los captura Stripe/PayPal.
const Stripe = require('stripe');

const currency = (process.env.CURRENCY || 'USD').toUpperCase();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const paypalBase = (process.env.PAYPAL_ENV || 'sandbox') === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';
const paypalEnabled = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

const money = (cents) => (cents / 100).toFixed(2);

async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${paypalBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('PayPal auth falló');
  return (await r.json()).access_token;
}

async function paypalCreateOrder(order, returnUrl, cancelUrl) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': order.public_id },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: order.public_id,
        amount: { currency_code: currency, value: money(order.total_cents) },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: returnUrl,
            cancel_url: cancelUrl,
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('PayPal no creó la orden');
  const link = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new Error('PayPal sin enlace de aprobación');
  return { id: data.id, approveUrl: link.href };
}

async function paypalCapture(paypalOrderId) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Captura PayPal falló');
  const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    completed: data.status === 'COMPLETED' && cap?.status === 'COMPLETED',
    value: cap?.amount?.value,
    currency: cap?.amount?.currency_code,
  };
}

module.exports = { stripe, paypalEnabled, paypalCreateOrder, paypalCapture, currency, money };
