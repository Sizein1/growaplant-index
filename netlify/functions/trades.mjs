// API des annonces de trade (stockage : Netlify Blobs, une entrée par annonce).
//   GET    /api/trades           -> liste publique
//   POST   /api/trades           -> publier (connecté avec Discord + membre du serveur)
//   DELETE /api/trades?id=...    -> supprimer (l'auteur, ou la clé admin dans l'en-tête x-admin-key)
//   POST   /api/trades/accept?id=... -> accepter : le bot crée un salon Discord privé pour les deux joueurs
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { getUser } from "../lib/session.mjs";
import { isMember, createTradeChannel, deleteChannel, channelUrl } from "../lib/discord.mjs";

const LIFETIME_MS = 7 * 24 * 3600 * 1000;      // une annonce ouverte dure 7 jours
const CHANNEL_LIFETIME_MS = 3 * 24 * 3600 * 1000; // un salon de trade dure 3 jours
const MAX_TRADES = 500;                         // plafond global, pour ne pas remplir le stockage
const MAX_PER_HOUR = 3;                         // annonces par compte Discord et par heure
const ITEM_RE = /^pet:[A-Za-z0-9_]{1,40}$/;     // seulement des pets : "pet:MossWolf"
const ROBLOX_RE = /^[A-Za-z0-9_]{3,20}$/;       // règles des pseudos Roblox
const LINK_RE = /(https?:\/\/|www\.|discord\.gg|\.(com|net|gg|io|xyz|ru)\b)/i;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const invite = () => process.env.DISCORD_INVITE || "";

async function listTrades(store) {
  const { blobs } = await store.list({ prefix: "trade/" });
  const now = Date.now();
  const trades = [];
  for (const { key } of blobs) {
    const trade = await store.get(key, { type: "json" });
    if (trade && trade.expiresAt > now) trades.push(trade); // les expirées sont effacées par cleanup-trades
  }
  return trades.sort((a, b) => b.createdAt - a.createdAt);
}

function cleanItems(list) {
  if (!Array.isArray(list)) return null;
  const items = [...new Set(list.filter((x) => typeof x === "string" && ITEM_RE.test(x)))];
  return items.length === list.length && items.length <= 8 ? items : null;
}

export default async (req) => {
  const store = getStore({ name: "trades", consistency: "strong" });
  const url = new URL(req.url);
  const user = getUser(req);

  if (req.method === "GET") return json({ trades: await listTrades(store) });

  // --- Accepter un trade ---
  if (req.method === "POST" && url.pathname.endsWith("/accept")) {
    if (!user) return json({ error: "login_required" }, 401);
    const id = url.searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad_request" }, 400);
    const key = `trade/${id}`;
    const found = await store.getWithMetadata(key, { type: "json" });
    const trade = found?.data;
    if (!trade || trade.expiresAt < Date.now()) return json({ error: "not_found" }, 404);
    if (trade.author.id === user.id) return json({ error: "own_trade" }, 400);
    if (trade.status !== "open") return json({ error: "already_taken" }, 409);
    if (!(await isMember(user.id))) return json({ error: "not_member", invite: invite() }, 403);

    // Verrou : une clé "lock/<id>" qui ne peut être créée qu'une fois (onlyIfNew), puis l'annonce n'est
    // modifiée que si personne ne l'a changée entre-temps (onlyIfMatch). Le premier gagne, les autres ont "already_taken".
    const accepter = { id: user.id, name: user.name };
    const lock = await store.set(`lock/${id}`, user.id, { onlyIfNew: true });
    if (!lock || lock.modified === false) return json({ error: "already_taken" }, 409);
    const claim = { ...trade, status: "accepting", acceptedBy: accepter };
    const claimed = await store.setJSON(key, claim, { onlyIfMatch: found.etag });
    if (!claimed || claimed.modified === false) return json({ error: "already_taken" }, 409);

    const deleteAt = Date.now() + CHANNEL_LIFETIME_MS;
    let channel;
    try {
      channel = await createTradeChannel(trade, accepter, url.origin, deleteAt);
    } catch (err) {
      console.error(err);
      await store.setJSON(key, trade); // échec côté Discord : l'annonce redevient disponible
      await store.delete(`lock/${id}`);
      return json({ error: "discord_error" }, 502);
    }
    const done = {
      ...claim, status: "in_progress", channelId: channel.id, acceptedAt: Date.now(),
      channelDeleteAt: deleteAt, expiresAt: Math.max(trade.expiresAt, deleteAt),
    };
    await store.setJSON(key, done);
    return json({ trade: done, channelUrl: channelUrl(channel.id) });
  }

  // --- Publier ---
  if (req.method === "POST") {
    if (!user) return json({ error: "login_required" }, 401);
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

    const kind = body.kind === "request" ? "request" : body.kind === "offer" ? "offer" : null;
    const have = cleanItems(body.have ?? []);
    const want = cleanItems(body.want ?? []);
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";
    const roblox = typeof body.roblox === "string" ? body.roblox.trim() : "";

    if (!kind || !have || !want) return json({ error: "invalid_items" }, 400);
    if (kind === "offer" && (!have.length || !want.length)) return json({ error: "offer_needs_both" }, 400);
    if (kind === "request" && !want.length) return json({ error: "request_needs_want" }, 400);
    if (!ROBLOX_RE.test(roblox)) return json({ error: "invalid_roblox" }, 400);
    if (LINK_RE.test(note)) return json({ error: "no_links" }, 400);
    // L'auteur doit être sur le serveur : sinon le bot ne pourra pas l'ajouter au salon du trade
    if (!(await isMember(user.id))) return json({ error: "not_member", invite: invite() }, 403);

    const rateKey = `rate/${user.id}`;
    const hour = Date.now() - 3600 * 1000;
    const recent = ((await store.get(rateKey, { type: "json" })) || []).filter((t) => t > hour);
    if (recent.length >= MAX_PER_HOUR) return json({ error: "rate_limited" }, 429);

    const { blobs } = await store.list({ prefix: "trade/" });
    if (blobs.length >= MAX_TRADES) return json({ error: "full" }, 503);

    const now = Date.now();
    const trade = {
      id: randomUUID(), kind, have, want, note, roblox, status: "open",
      author: { id: user.id, name: user.name }, createdAt: now, expiresAt: now + LIFETIME_MS,
    };
    await store.setJSON(`trade/${trade.id}`, trade);
    await store.setJSON(rateKey, [...recent, now]);
    return json({ trade }, 201);
  }

  // --- Supprimer ---
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id") || "";
    if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad_request" }, 400);
    const trade = await store.get(`trade/${id}`, { type: "json" });
    if (!trade) return json({ error: "not_found" }, 404);
    const adminKey = req.headers.get("x-admin-key") || "";
    const admin = process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY;
    if (!admin && (!user || user.id !== trade.author.id)) return json({ error: "forbidden" }, 403);
    if (trade.channelId) await deleteChannel(trade.channelId); // supprimer un trade en cours ferme aussi son salon
    await store.delete(`trade/${id}`);
    await store.delete(`lock/${id}`);
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: ["/api/trades", "/api/trades/accept"] };
