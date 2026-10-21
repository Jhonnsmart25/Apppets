# Patitas App

Full-stack: Node.js + Express sirve la PWA (`public/`) y la API (`/api/...`).

## Despliegue en Render
1. Sube estos archivos a un repositorio de GitHub (en la raíz).
2. En Render: New → Web Service → conecta el repo → Runtime **Docker** (o New → Blueprint si quieres usar `render.yaml`).
3. Variables de entorno: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.
4. En Stripe → Developers → Webhooks, agrega el endpoint `https://TU-APP.onrender.com/api/webhook` con los eventos
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copia el "Signing secret" (`whsec_...`) a `STRIPE_WEBHOOK_SECRET`.
5. En Stripe activa el Customer Portal (Settings → Billing → Customer portal).
6. Abre la URL de Render en Chrome Android → botón **Instalar app**.

## Local
`npm install && node server.js` → http://localhost:10000 (sin claves de Stripe corre en modo demo).
