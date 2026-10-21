"use strict";
const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 10000;
const TRIAL_DAYS = 7;
const { STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET } = process.env;
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;
const stripeReady = Boolean(stripe && STRIPE_PRICE_ID);
if (!stripeReady) console.warn("[patitas] Stripe sin configurar: modo demo (planes abiertos, sin cobro).");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});

const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const normEmail = e => String(e || "").trim().toLowerCase();
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e) && e.length <= 254;

// ---------- Estado de suscripción (consulta a Stripe + caché corta) ----------
const cache = new Map();
async function subscriptionFor(email) {
  const hit = cache.get(email);
  if (hit && Date.now() - hit.t < 30000) return hit.v;
  let v = { active: false, status: "none" };
  const customers = await stripe.customers.list({ email, limit: 5 });
  for (const c of customers.data) {
    const subs = await stripe.subscriptions.list({ customer: c.id, status: "all", limit: 10 });
    for (const s of subs.data) {
      if (s.status === "active" || s.status === "trialing") {
        v = {
          active: true, status: s.status, customerId: c.id,
          trialEnd: s.trial_end || null,
          currentPeriodEnd: s.current_period_end || null,
          cancelAtPeriodEnd: s.cancel_at_period_end,
        };
        break;
      }
    }
    if (v.active) break;
    if (!v.customerId) v.customerId = c.id;
  }
  cache.set(email, { t: Date.now(), v });
  return v;
}

// ---------- Webhook de Stripe (ANTES de express.json: necesita el cuerpo crudo) ----------
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send("Webhook no configurado");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn("[webhook] firma inválida:", err.message);
    return res.status(400).send("Firma inválida");
  }
  try {
    const obj = event.data.object;
    let email = null;
    if (event.type === "checkout.session.completed") {
      email = normEmail(obj.customer_details && obj.customer_details.email);
    } else if (event.type.startsWith("customer.subscription.") || event.type.startsWith("invoice.")) {
      const c = await stripe.customers.retrieve(obj.customer);
      email = normEmail(c.email);
    }
    if (email) cache.delete(email);
    console.log(`[webhook] ${event.type}${email ? " → " + email : ""}`);
    // Aquí puedes guardar el evento en tu base de datos si la agregas más adelante.
  } catch (err) {
    console.error("[webhook] error procesando evento:", err.message);
    return res.status(500).send("Error");
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "20kb" }));

// ---------- Límite simple de peticiones por IP ----------
const hits = new Map();
app.use("/api", (req, res, next) => {
  const now = Date.now(), k = req.ip, e = hits.get(k) || { n: 0, t: now };
  if (now - e.t > 60000) { e.n = 0; e.t = now; }
  e.n++; hits.set(k, e);
  if (e.n > 60) return res.status(429).json({ error: "Demasiadas peticiones. Intenta en un minuto." });
  next();
});
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// ---------- API ----------
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/config", (req, res) => res.json({ stripeReady, trialDays: TRIAL_DAYS }));

app.get("/api/subscription", async (req, res) => {
  if (!stripeReady) return res.json({ active: true, status: "demo" });
  const email = normEmail(req.query.email);
  if (!validEmail(email)) return res.status(400).json({ error: "Correo inválido" });
  try {
    const s = await subscriptionFor(email);
    res.json({ active: s.active, status: s.status, trialEnd: s.trialEnd, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: "No se pudo consultar la suscripción" });
  }
});

app.post("/api/checkout", async (req, res) => {
  if (!stripeReady) return res.status(503).json({ error: "Stripe aún no está configurado en el servidor." });
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return res.status(400).json({ error: "Escribe un correo válido." });
  try {
    const existing = await subscriptionFor(email);
    if (existing.active) return res.json({ already: true });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: TRIAL_DAYS },
      allow_promotion_codes: true,
      success_url: `${baseUrl(req)}/?checkout=success`,
      cancel_url: `${baseUrl(req)}/?checkout=cancel`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("[checkout]", err.message);
    res.status(502).json({ error: "No se pudo iniciar el pago." });
  }
});

app.post("/api/portal", async (req, res) => {
  if (!stripeReady) return res.status(503).json({ error: "Stripe aún no está configurado." });
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return res.status(400).json({ error: "Correo inválido" });
  try {
    const s = await subscriptionFor(email);
    if (!s.customerId) return res.status(404).json({ error: "No encontramos una cuenta con ese correo." });
    const portal = await stripe.billingPortal.sessions.create({ customer: s.customerId, return_url: baseUrl(req) });
    res.json({ url: portal.url });
  } catch (err) {
    console.error("[portal]", err.message);
    res.status(502).json({ error: "No se pudo abrir el portal." });
  }
});

// ---------- Motor de recomendaciones (protegido por suscripción) ----------
const pick = (v, list) => list.includes(v);
function validatePet(p) {
  if (!p || typeof p !== "object") return null;
  const peso = Number(p.peso), edad = Number(p.edad);
  if (!pick(p.sp, ["perro", "gato"]) || !(peso >= 0.3 && peso <= 90) || !(edad >= 1 && edad <= 300)) return null;
  return {
    sp: p.sp, peso, edad,
    sexo: pick(p.sexo, ["m", "h"]) ? p.sexo : "m",
    est: pick(p.est, ["si", "no"]) ? p.est : "si",
    act: pick(p.act, ["b", "m", "a"]) ? p.act : "m",
    cuerpo: pick(p.cuerpo, ["i", "s", "d"]) ? p.cuerpo : "i",
    pelo: pick(p.pelo, ["c", "l", "r", "d"]) ? p.pelo : "c",
    pre: p.sexo === "h" && pick(p.pre, ["1", "2"]) ? p.pre : "no",
  };
}

function buildPlan(d) {
  const perro = d.sp === "perro";
  const rer = 70 * Math.pow(d.peso, 0.75);
  let etapa, f;
  if (d.edad < 4) { etapa = "cachorro pequeño"; f = perro ? 3 : 2.5; }
  else if (d.edad < 12) { etapa = perro ? "cachorro" : "gatito"; f = perro ? 2 : 2.5; }
  else if (d.edad >= (perro ? 84 : 120)) { etapa = "senior"; f = perro ? 1.4 : 1.1; }
  else { etapa = "adulto"; f = perro ? (d.est === "si" ? 1.6 : 1.8) : (d.est === "si" ? 1.2 : 1.4); }
  let kcal = rer * f * { b: 0.9, m: 1, a: 1.2 }[d.act];
  if (d.cuerpo === "s") kcal *= 0.8;
  if (d.cuerpo === "d") kcal *= 1.15;
  if (d.pre === "2") kcal *= 1.35;
  kcal = Math.round(kcal / 10) * 10;
  const gramos = Math.round(kcal / 3.5 / 5) * 5;
  const comidas = d.edad < 4 ? 4 : d.edad < 12 ? 3 : perro ? 2 : 3;

  const paseo = [];
  if (perro) {
    if (d.edad < 12) paseo.push(`Paseos cortos: unos ${Math.max(5, Math.round(d.edad * 5 / 2))} min, dos veces al día (regla de 5 min por mes de edad).`);
    else {
      let m = (d.peso < 10 ? 30 : d.peso < 25 ? 60 : 90) * { b: 0.7, m: 1, a: 1.3 }[d.act];
      if (etapa === "senior") m *= 0.7;
      paseo.push(`Ejercicio total al día: unos ${Math.round(m / 5) * 5} min, repartidos en 2 paseos.`);
    }
    paseo.push("Añade juego de olfato (esconder premios) 10 min para reducir la ansiedad.");
    if (d.cuerpo === "s") paseo.push("Con sobrepeso, aumenta el tiempo poco a poco y evita el calor fuerte.");
  } else {
    paseo.push("2 o 3 sesiones de juego de 10–15 min (caña con plumas, bolitas).");
    paseo.push("Rascador alto y ventanas con vista para enriquecer su espacio.");
    paseo.push("Arnés y paseos cortos son opcionales, solo si se adapta con calma.");
  }

  const nutri = [
    `Unos ${gramos} g/día de croqueta de ~3500 kcal/kg, en ${comidas} comidas. Ajusta según la bolsa de tu alimento.`,
    /cachorro|gatito/.test(etapa) ? "Usa alimento específico para crecimiento." : etapa === "senior" ? "Usa alimento senior; revisa articulaciones y dientes con tu veterinario." : "Alimento completo y balanceado para adultos.",
    "Agua fresca siempre." + (perro ? "" : " En gatos, mezclar comida húmeda ayuda a los riñones."),
    perro ? "Evita chocolate, uvas, pasas, cebolla, ajo y xilitol." : "Evita cebolla, ajo, chocolate, uvas, pasas y lirios (muy tóxicos).",
    "Pésalo cada 2 semanas: si sube o baja más de 5%, ajusta o consulta al veterinario.",
  ];
  if (d.pre === "1") nutri.push("Gestación temprana: mantén la ración y sube gradualmente desde la semana 5–6 con tu veterinario.");
  if (d.pre === "2") nutri.push("Último tercio: ración ~35% mayor, más comidas pequeñas y alimento de crecimiento, según indique tu veterinario. Prepara el parto con él.");

  const aseo = [
    "Uñas: " + (perro ? "cada 2–4 semanas." : "cada 2–3 semanas."),
    "Pelaje: " + { c: "cepillado 1–2 veces por semana; normalmente no requiere corte.", l: "cepillado diario para evitar nudos; corte o arreglo cada 6–8 semanas.", r: "cepillado diario; corte cada 4–6 semanas para evitar nudos.", d: "cepillado 2–3 veces por semana (diario en muda); no lo rasures, protege su temperatura." }[d.pelo],
  ];
  const calma = d.act === "a" ? "Con actividad alta, más ejercicio mental ayuda a evitar destrozos y ansiedad." : "Rutinas fijas de comida y paseo, y un rincón tranquilo, reducen la ansiedad.";
  return { etapa, kcal, gramos, comidas, nutri, paseo, aseo, calma };
}

app.post("/api/plan", async (req, res) => {
  const pet = validatePet(req.body.pet);
  if (!pet) return res.status(400).json({ error: "Datos de la mascota inválidos." });
  if (stripeReady) {
    const email = normEmail(req.body.email);
    if (!validEmail(email)) return res.status(402).json({ error: "Inicia tu prueba gratis para ver el plan." });
    try {
      const s = await subscriptionFor(email);
      if (!s.active) return res.status(402).json({ error: "Necesitas una suscripción activa o tu prueba gratis." });
    } catch (err) {
      console.error(err.message);
      return res.status(502).json({ error: "No se pudo verificar tu suscripción." });
    }
  }
  res.json(buildPlan(pet));
});

app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada" }));

// ---------- Archivos estáticos (PWA) ----------
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, file) {
    if (file.endsWith("sw.js")) res.set("Cache-Control", "no-cache");
    if (file.endsWith(".webmanifest")) res.set("Content-Type", "application/manifest+json");
  },
}));

app.listen(PORT, () => console.log(`[patitas] escuchando en puerto ${PORT}`));
