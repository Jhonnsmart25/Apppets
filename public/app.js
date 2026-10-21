"use strict";
const $ = id => document.getElementById(id);
let sp = "perro", cfg = { stripeReady: false, trialDays: 7 };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const api = async (url, opts) => {
  const r = await fetch(url, opts && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
};
function el(tag, text, cls) { const n = document.createElement(tag); if (text) n.textContent = text; if (cls) n.className = cls; return n; }
function card(title, items, para) {
  const c = el("div", "", "card"); c.appendChild(el("h2", title));
  if (para) c.appendChild(el("p", para));
  if (items) { const ul = el("ul"); items.forEach(t => ul.appendChild(el("li", t))); c.appendChild(ul); }
  return c;
}

function renderPlan(pet, p) {
  const out = $("out"); out.replaceChildren();
  const head = el("div", "", "card");
  head.append(el("h2", "Plan de " + pet.nombre), el("p", "Etapa: " + p.etapa, "muted"), el("p", p.kcal + " kcal/día", "big"));
  out.append(head, card("🍽️ Comida", p.nutri),
    card(pet.sp === "perro" ? "🦮 Paseo y ejercicio" : "🧶 Juego y ejercicio", p.paseo),
    card("✂️ Aseo", p.aseo), card("😌 Tranquilidad", null, p.calma));
  out.hidden = false; $("paywall").hidden = true;
  out.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth" });
}

function showPaywall(msg) {
  $("out").hidden = true; $("paywall").hidden = false;
  $("email").value = store.get("email") || "";
  $("payMsg").textContent = msg || "";
  $("paywall").scrollIntoView({ block: "center" });
}

async function loadPlan(pet) {
  const r = await api("/api/plan", { email: store.get("email") || "", pet });
  if (r.ok) { renderPlan(pet, r.data); refreshBanner(); }
  else if (r.status === 402) showPaywall(r.data.error);
  else alert(r.data.error || "Algo salió mal. Intenta de nuevo.");
}

async function refreshBanner() {
  const b = $("banner"), email = store.get("email");
  $("manage").hidden = true;
  if (!cfg.stripeReady) { b.hidden = false; b.textContent = "Modo demo: Stripe aún no está configurado."; return; }
  if (!email) { b.hidden = true; return; }
  const r = await api("/api/subscription?email=" + encodeURIComponent(email));
  if (!r.ok || !r.data.active) { b.hidden = true; return; }
  const fmt = t => new Date(t * 1000).toLocaleDateString("es", { day: "numeric", month: "long" });
  b.hidden = false;
  b.textContent = r.data.status === "trialing" ? "Prueba gratis hasta el " + fmt(r.data.trialEnd) + "." : "Suscripción activa.";
  $("manage").hidden = false;
}

$("species").onclick = e => {
  const b = e.target.closest("button[data-sp]"); if (!b) return;
  sp = b.dataset.sp;
  document.querySelectorAll("#species button[data-sp]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
};
$("sexo").onchange = () => { $("preWrap").hidden = $("sexo").value !== "h"; };

$("form").onsubmit = e => {
  e.preventDefault();
  const pet = { sp, nombre: $("nombre").value.trim(), peso: +$("peso").value, edad: +$("edad").value, sexo: $("sexo").value,
    est: $("est").value, act: $("act").value, cuerpo: $("cuerpo").value, pelo: $("pelo").value,
    pre: $("sexo").value === "h" ? $("pre").value : "no" };
  store.set("pet", JSON.stringify(pet));
  loadPlan(pet);
};

$("start").onclick = async () => {
  const email = $("email").value.trim().toLowerCase(), btn = $("start");
  if (!/^\S+@\S+\.\S+$/.test(email)) { $("payMsg").textContent = "Escribe un correo válido."; return; }
  store.set("email", email); btn.disabled = true; $("payMsg").textContent = "";
  const r = await api("/api/checkout", { email });
  btn.disabled = false;
  if (r.ok && r.data.url) location.href = r.data.url;
  else if (r.ok && r.data.already) { const pet = JSON.parse(store.get("pet") || "null"); if (pet) loadPlan(pet); }
  else $("payMsg").textContent = r.data.error || "No se pudo iniciar el pago.";
};

$("manage").onclick = async () => {
  const r = await api("/api/portal", { email: store.get("email") });
  if (r.ok && r.data.url) location.href = r.data.url; else alert(r.data.error || "No se pudo abrir el portal.");
};

let deferred;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferred = e; $("install").hidden = false; });
addEventListener("appinstalled", () => { $("install").hidden = true; });
$("install").onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $("install").hidden = true; };
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

(async function init() {
  const c = await api("/api/config"); if (c.ok) cfg = c.data;
  const pet = JSON.parse(store.get("pet") || "null");
  if (pet) {
    $("nombre").value = pet.nombre; $("peso").value = pet.peso; $("edad").value = pet.edad;
    ["sexo", "est", "act", "cuerpo", "pelo", "pre"].forEach(k => { if (pet[k]) $(k).value = pet[k]; });
    $("preWrap").hidden = pet.sexo !== "h";
    sp = pet.sp; document.querySelectorAll("#species button[data-sp]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.sp === sp)));
  }
  const q = new URLSearchParams(location.search).get("checkout");
  if (q) history.replaceState({}, "", "/");
  await refreshBanner();
  if (q === "success" && pet) loadPlan(pet);
  else if (q === "cancel") showPaywall("No se completó el registro. Cuando quieras, vuelve a intentarlo.");
})();
