// API des annonces de trade : GET (liste), POST (publier), DELETE (supprimer).
// Stockage : Netlify Blobs, une entrée par annonce. Aucune donnée n'est conservée après expiration.
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const LIFETIME_MS = 7 * 24 * 3600 * 1000; // une annonce dure 7 jours
const MAX_TRADES = 500;                   // plafond global, pour ne pas remplir le stockage
const MAX_PER_HOUR = 3;                   // annonces par personne et par heure
const ITEM_RE = /^pet:[A-Za-z0-9_]{1,40}$/;          // seulement des pets : "pet:MossWolf"
const ROBLOX_RE = /^[A-Za-z0-9_]{3,20}$/;              // règles des pseudos Roblox
const LINK_RE = /(https?:\/\/|www\.|discord\.gg|\.(com|net|gg|io|xyz|ru)\b)/i;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Ce que tout le monde peut voir (jamais le hash du jeton de suppression)
const publicView = ({ tokenHash, ipHash, ...rest }) => rest;

async function listTrades(store) {
  const { blobs } = await store.list({ prefix: "trade/" });
  const now = Date.now();
  const trades = [];
  for (const { key } of blobs) {
    const trade = await store.get(key, { type: "json" });
    if (!trade) continue;
    if (trade.expiresAt < now) { await store.delete(key); continue; } // nettoyage des annonces expirées
    trades.push(trade);
  }
  return trades.sort((a, b) => b.createdAt - a.createdAt);
}

function cleanItems(list) {
  if (!Array.isArray(list)) return null;
  const items = [...new Set(list.filter((x) => typeof x === "string" && ITEM_RE.test(x)))];
  return items.length === list.length && items.length <= 8 ? items : null;
}

export default async (req, context) => {
  const store = getStore({ name: "trades", consistency: "strong" });

  if (req.method === "GET") {
    const trades = await listTrades(store);
    return json({ trades: trades.map(publicView) });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    const kind = body.kind === "request" ? "request" : body.kind === "offer" ? "offer" : null;
    const have = cleanItems(body.have ?? []);
    const want = cleanItems(body.want ?? []);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    const roblox = typeof body.roblox === "string" ? body.roblox.trim() : "";
    const discord = typeof body.discord === "string" ? body.discord.trim().slice(0, 40) : "";

    if (!kind || !have || !want) return json({ error: "invalid_items" }, 400);
    if (kind === "offer" && (!have.length || !want.length)) return json({ error: "offer_needs_both" }, 400);
    if (kind === "request" && !want.length) return json({ error: "request_needs_want" }, 400);
    if (!ROBLOX_RE.test(roblox)) return json({ error: "invalid_roblox" }, 400);
    if (discord && !/^[A-Za-z0-9_.]{2,32}$/.test(discord)) return json({ error: "invalid_discord" }, 400);
    if (LINK_RE.test(note) || LINK_RE.test(discord)) return json({ error: "no_links" }, 400);

    // Limite par personne : adresse IP hachée (jamais stockée en clair), fenêtre d'une heure
    const ipHash = sha256((context.ip || "?") + (process.env.RATE_SALT || "growaplant"));
    const rateKey = `rate/${ipHash}`;
    const hour = Date.now() - 3600 * 1000;
    const recent = ((await store.get(rateKey, { type: "json" })) || []).filter((t) => t > hour);
    if (recent.length >= MAX_PER_HOUR) return json({ error: "rate_limited" }, 429);

    const { blobs } = await store.list({ prefix: "trade/" });
    if (blobs.length >= MAX_TRADES) return json({ error: "full" }, 503);

    const token = randomBytes(24).toString("hex");
    const now = Date.now();
    const trade = {
      id: randomUUID(), kind, have, want, note, roblox, discord,
      createdAt: now, expiresAt: now + LIFETIME_MS, tokenHash: sha256(token),
    };
    await store.setJSON(`trade/${trade.id}`, trade);
    await store.setJSON(rateKey, [...recent, now]);
    return json({ trade: publicView(trade), token }, 201);
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id") || "";
    const token = req.headers.get("x-trade-token") || "";
    if (!/^[0-9a-f-]{36}$/.test(id) || !token) return json({ error: "bad_request" }, 400);
    const trade = await store.get(`trade/${id}`, { type: "json" });
    if (!trade) return json({ error: "not_found" }, 404);
    const admin = process.env.ADMIN_KEY && token === process.env.ADMIN_KEY; // clé admin : supprime n'importe quelle annonce
    if (!admin && sha256(token) !== trade.tokenHash) return json({ error: "forbidden" }, 403);
    await store.delete(`trade/${id}`);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: "/api/trades" };
