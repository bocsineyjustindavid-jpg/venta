# Tienda de ropa

Tienda en línea con parte pública y panel de administración.

## Qué incluye

**Público (cualquier persona)**
- Sección "Recién llegados" y catálogo completo con búsqueda, categorías, tallas y existencias.
- Carrito de compras (se guarda en el navegador).
- Pago con tarjeta de débito/crédito (Stripe) o PayPal.
- Reseñas de clientes (se publican cuando el administrador las aprueba).
- Formulario de dudas/comentarios y botón de WhatsApp.

**Administrador (solo con usuario y contraseña, en `/admin/`)**
- Agregar, editar y eliminar prendas: nombre, precio, tallas, existencias, foto, "nuevo", visible/oculto.
- Ver, aprobar u ocultar reseñas y comentarios.
- Leer los mensajes que llegan por el formulario.
- Ver pedidos y cambiar su estado (pagado, enviado, entregado…).
- Cambiar su contraseña.

## Instalación

Requiere [Node.js 20 o superior](https://nodejs.org).

```bash
npm install
cp .env.example .env     # en Windows: copy .env.example .env
# edita .env (WhatsApp, nombre de la tienda, claves de pago)
npm start
```

Abre http://localhost:3000 (tienda) y http://localhost:3000/admin/ (panel).
La **primera vez** que arranca se crea el administrador y la contraseña aparece en la consola
(o usa la de `ADMIN_PASSWORD`). Cámbiala desde la pestaña "Cuenta".

## Activar los pagos

1. **Tarjeta (Stripe)**: crea cuenta en stripe.com, copia la clave secreta a `STRIPE_SECRET_KEY`.
   Crea un webhook apuntando a `https://TU-DOMINIO/api/stripe/webhook` con los eventos
   `checkout.session.completed` y `checkout.session.async_payment_succeeded`, y copia su secreto a `STRIPE_WEBHOOK_SECRET`.
   Para probar local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.
2. **PayPal**: en developer.paypal.com crea una app, copia `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET`.
   Usa `PAYPAL_ENV=sandbox` para pruebas y `live` cuando cobres de verdad.
3. Moneda: `CURRENCY=USD` por defecto. Los precios del panel se interpretan en esa moneda.
   Verifica que tu cuenta de Stripe/PayPal pueda cobrar en la moneda que elijas.

Los botones de pago solo aparecen cuando las claves están configuradas.

## Seguridad incluida

| Riesgo | Protección |
|---|---|
| Inyección SQL | Solo consultas parametrizadas; restricciones `CHECK` en la base de datos |
| XSS | Cabecera CSP estricta (sin scripts ni estilos en línea); el contenido se inserta con `textContent`, nunca `innerHTML` |
| CSRF | Token por sesión en cada petición que modifica datos + comprobación de `Origin` + cookies `SameSite=Strict` |
| Robo de sesión | Cookie `HttpOnly`, `Secure` y prefijo `__Host-` en producción; sesión se regenera al entrar; caduca a las 2 h |
| Fuerza bruta | Límite de intentos por IP y bloqueo temporal por usuario; contraseñas con bcrypt (coste 12); comparación en tiempo constante |
| Manipular precios | El precio y las existencias se calculan **en el servidor**; el navegador solo envía id, talla y cantidad |
| Datos de tarjeta | Nunca tocan tu servidor: los procesan Stripe y PayPal (el pago se confirma por webhook firmado / captura del servidor) |
| Subida de archivos | Solo JPG/PNG/WEBP verificados por su contenido real, máx. 3 MB, nombre aleatorio (no se aceptan SVG) |
| Spam | Límite de envíos por IP, campo trampa (honeypot), reseñas moderadas |
| Otros | Helmet (HSTS, nosniff, anti-clickjacking), límite de tamaño de peticiones, protección contra parámetros duplicados, errores sin detalles internos, base de datos con permisos 600 |

## Para publicarla en internet

- Usa **HTTPS** siempre (por ejemplo detrás de Nginx/Caddy o en una plataforma como Render/Railway/Fly).
- En `.env`: `NODE_ENV=production`, `BASE_URL=https://tu-dominio.com`, `TRUST_PROXY=1` si hay proxy.
- Quita `ADMIN_PASSWORD` del `.env` después del primer arranque.
- No subas `.env` ni la carpeta `data/`. Haz copias de seguridad de `data/` y `public/uploads/`.
- Ejecuta `npm audit` de vez en cuando y actualiza dependencias.
- Si el servidor reinicia, el disco debe ser persistente (la base de datos es el archivo `data/tienda.db`).
- Para más de una instancia o mucho tráfico, migra a PostgreSQL y un almacén de sesiones compartido.

## Estructura

```
server.js        API, seguridad, administrador, pagos
db.js            esquema de la base de datos (SQLite)
payments.js      Stripe y PayPal
sessionStore.js  sesiones guardadas en la base de datos
public/          tienda (index.html, app.js, styles.css) y panel (admin/)
```
