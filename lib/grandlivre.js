// Grandlivre payment links: make a link per order, check signed webhooks, read payment status.
// Grandlivre never moves money and never confirms it by itself: only a "confirmed" payment,
// marked by the owner in Grandlivre, counts as paid. The key and secret stay on the server.
import crypto from "node:crypto";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Returns { baseUrl, origin, key, secret } when Grandlivre is fully configured, otherwise null.
export function grandlivreConfig(env = process.env) {
  const key = env.GRANDLIVRE_KEY;
  const secret = env.GRANDLIVRE_WEBHOOK_SECRET;
  if (!key || !secret) return null;
  let url;
  try {
    url = new URL(env.GRANDLIVRE_URL || "https://app.portemonnaie.space");
  } catch {
    return null;
  }
  // Keys travel in a header, so plain http is only allowed for a server on this machine (tests).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return null;
  return { baseUrl: url.origin, origin: url.origin, key, secret };
}

// X-Grandlivre-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
export function verifySignature({ header, rawBody, secret, now = Date.now(), toleranceSeconds = 300 }) {
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/i.exec(String(header || "").trim());
  if (!match || !secret) return false;
  const [, t, v1] = match;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""));
  const expected = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${t}.`), body])).digest();
  const received = Buffer.from(v1, "hex");
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// A payment's amount is a decimal in currency units (2.5 = €2.50); the order price is in cents.
export function amountMatches(amount, currency, expectedCents) {
  return String(currency || "").toUpperCase() === "EUR"
    && typeof amount === "number" && Number.isFinite(amount)
    && Math.round(amount * 100) === expectedCents;
}

// The webhook names the link by id; accept the token or the page address too, so a difference in
// how Grandlivre writes it cannot reject a real payment. Anything else is not our link.
export function linkMatches(value, order) {
  const text = String(value ?? "");
  if (!text) return false;
  return text === order.pay_link_id || text === order.pay_link_token
    || (Boolean(order.pay_link_token) && text.endsWith(`/${order.pay_link_token}`));
}

// Order payment states: awaiting_payment, payment_reported, paid, payment_problem, payment_mismatch
// (plus manual_payment, expired and cancelled, which no payment event can change). Never leaves "paid".
export function nextPayState(current, incoming) {
  if (current === "paid") return "paid";
  if (!["awaiting_payment", "payment_reported", "payment_problem", "payment_mismatch"].includes(current)) return current;
  if (incoming === "confirmed") return "paid";
  if (incoming === "reported") return current === "payment_reported" ? current : "payment_reported";
  if (incoming === "declined") return current === "payment_mismatch" ? current : "payment_problem";
  return current;
}

async function call(config, method, pathname, { body, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const response = await fetchImpl(`${config.baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${config.key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, data };
}

// One link per order. Retries once on a network error, timeout or 5xx; any other answer is final.
export async function createPayLink(config, { orderCode, priceCents }, options = {}) {
  const body = { title: `Print order #${orderCode}`, amount: priceCents / 100, currency: "EUR", ref: orderCode };
  let lastError = new Error("Grandlivre could not be reached");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result;
    try {
      result = await call(config, "POST", "/api/v1/pay-links", { ...options, body });
    } catch (error) {
      lastError = error;
      continue;
    }
    const link = result.data?.link;
    if (result.ok && link?.id && link.token) {
      return { id: String(link.id), token: String(link.token), url: link.url ? String(link.url) : null };
    }
    lastError = new Error(`Grandlivre answered ${result.status}`);
    if (result.status < 500) break;
  }
  throw lastError;
}

export async function fetchNotices(config, ref, options = {}) {
  const result = await call(config, "GET", `/api/v1/notices?ref=${encodeURIComponent(ref)}`, options);
  if (!result.ok || !Array.isArray(result.data?.notices)) throw new Error(`Grandlivre answered ${result.status} for notices`);
  // Newest first from the API; apply oldest first.
  return [...result.data.notices].reverse();
}

export async function closePayLink(config, linkId, options = {}) {
  const result = await call(config, "DELETE", `/api/v1/pay-links/${encodeURIComponent(linkId)}`, options);
  return result.ok;
}
