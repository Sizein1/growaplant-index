// API des giveaways.
//   GET    /api/giveaways              -> giveaways en cours et terminés récemment (+ les siens en attente / refusés)
//   POST   /api/giveaways              -> proposer un giveaway (connecté Discord, membre du serveur) : part en validation
//   POST   /api/giveaways/enter?id=... -> participer
//   POST   /api/giveaways?action=end&id=... -> terminer tout de suite (clé admin)
//   DELETE /api/giveaways?id=...       -> annuler le sien tant qu'il n'est pas validé (ou clé admin : n'importe lequel)
import { randomUUID } from "node:crypto";
import { getUser } from "../lib/session.mjs";
import { isMember, deleteChannel, editMessage } from "../lib/discord.mjs";
import { store, gwKey, entryPrefix, getGiveaway, saveGiveaway, postValidation, draw, MAX_ITEMS, KEEP_FINISHED_MS, GW } from "../lib/giveaways.mjs";

const ITEM_RE = /^(pet|egg):[A-Za-z0-9_]{1,40}$/;
const ROBLOX_RE = /^[A-Za-z0-9_]{3,20}$/;
const LINK_RE = /(https?:\/\/|www\.|discord\.gg|\.(com|net|gg|io|xyz|ru)\b)/i;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const invite = () => process.env.DISCORD_INVITE || "";

// Vue publique : sans les identifiants de messages Discord
const publicView = ({ validationMsg, announceMsg, ...gw }, count, entered) => ({ ...gw, count, entered });

export default async (req) => {
  const s = store();
  const url = new URL(req.url);
  const user = getUser(req);

  if (req.method === "GET") {
    const { blobs } = await s.list({ prefix: "gw/" });
    const now = Date.now();
    const out = [];
    for (const { key } of blobs) {
      const gw = await s.get(key, { type: "json" });
      if (!gw) continue;
      const mine = user && user.id === gw.creator.id;
      const visible = gw.status === "active" || (gw.finishedAt && now - gw.finishedAt < KEEP_FINISHED_MS && gw.status !== "rejected") || mine;
      if (!visible) continue;
      const entries = (await s.list({ prefix: entryPrefix(gw.id) })).blobs;
      const entered = !!user && entries.some((b) => b.key === `${entryPrefix(gw.id)}${user.id}`);
      out.push(publicView(gw, entries.length, entered));
    }
    out.sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || (a.endsAt || a.createdAt) - (b.endsAt || b.createdAt));
    return json({ giveaways: out });
  }

  // --- Terminer tout de suite (admin uniquement) : le tirage a lieu immédiatement ---
  if (req.method === "POST" && url.searchParams.get("action") === "end") {
    const adminKey = req.headers.get("x-admin-key") || "";
    if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) return json({ error: "forbidden" }, 403);
    const gw = await getGiveaway(url.searchParams.get("id") || "");
    if (!gw) return json({ error: "not_found" }, 404);
    if (gw.status !== "active") return json({ error: "not_active" }, 409);
    const ending = { ...gw, endsAt: Date.now(), status: "drawing" }; // "drawing" : la tâche planifiée ne le tire pas en double
    await saveGiveaway(ending);
    try {
      const done = await draw(ending, url.origin);
      await saveGiveaway(done);
      return json({ giveaway: publicView(done, done.entries ?? 0, false) });
    } catch (err) {
      console.error(err);
      await saveGiveaway({ ...ending, status: "active" }); // la tâche planifiée retentera dans la minute
      return json({ error: "discord_error" }, 502);
    }
  }

  // --- Participer ---
  if (req.method === "POST" && url.pathname.endsWith("/enter")) {
    if (!user) return json({ error: "login_required" }, 401);
    const gw = await getGiveaway(url.searchParams.get("id") || "");
    if (!gw) return json({ error: "not_found" }, 404);
    if (gw.status !== "active" || gw.endsAt <= Date.now()) return json({ error: "not_active" }, 409);
    if (gw.creator.id === user.id) return json({ error: "own_giveaway" }, 400);
    if (!(await isMember(user.id))) return json({ error: "not_member", invite: invite() }, 403);
    await s.setJSON(`${entryPrefix(gw.id)}${user.id}`, { name: user.name, at: Date.now() }, { onlyIfNew: true }); // une seule participation
    const count = (await s.list({ prefix: entryPrefix(gw.id) })).blobs.length;
    return json({ ok: true, count });
  }

  // --- Proposer ---
  if (req.method === "POST") {
    if (!user) return json({ error: "login_required" }, 401);
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const items = Array.isArray(body.items) ? [...new Set(body.items)] : [];
    const hours = Number(body.hours);
    const roblox = typeof body.roblox === "string" ? body.roblox.trim() : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 300) : "";

    if (!items.length || items.length > MAX_ITEMS || !items.every((x) => typeof x === "string" && ITEM_RE.test(x))) return json({ error: "invalid_items" }, 400);
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) return json({ error: "invalid_hours" }, 400);
    if (!ROBLOX_RE.test(roblox)) return json({ error: "invalid_roblox" }, 400);
    if (LINK_RE.test(note)) return json({ error: "no_links" }, 400);
    if (!(await isMember(user.id))) return json({ error: "not_member", invite: invite() }, 403);

    // Un seul giveaway en attente ou en cours par personne
    const { blobs } = await s.list({ prefix: "gw/" });
    for (const { key } of blobs) {
      const other = await s.get(key, { type: "json" });
      if (other && other.creator.id === user.id && (other.status === "pending" || other.status === "active")) return json({ error: "already_running" }, 409);
    }

    const gw = {
      id: randomUUID(), creator: { id: user.id, name: user.name }, items, hours, roblox, note,
      status: "pending", createdAt: Date.now(),
    };
    try {
      gw.validationMsg = await postValidation(gw, url.origin);
    } catch (err) {
      console.error(err);
      return json({ error: "discord_error" }, 502);
    }
    await saveGiveaway(gw);
    return json({ giveaway: publicView(gw, 0, false) }, 201);
  }

  // --- Annuler ---
  if (req.method === "DELETE") {
    const gw = await getGiveaway(url.searchParams.get("id") || "");
    if (!gw) return json({ error: "not_found" }, 404);
    const adminKey = req.headers.get("x-admin-key") || "";
    const admin = process.env.ADMIN_KEY && adminKey === process.env.ADMIN_KEY;
    const ownPending = user && user.id === gw.creator.id && gw.status === "pending";
    if (!admin && !ownPending) return json({ error: "forbidden" }, 403);
    if (gw.status === "pending" && gw.validationMsg) {
      await editMessage(GW.validation, gw.validationMsg, { content: `🚫 Annulé par son créateur / Cancelled — <@${gw.creator.id}>`, components: [], allowed_mentions: { parse: [] } });
    }
    if (gw.channelId) await deleteChannel(gw.channelId);
    for (const { key } of (await s.list({ prefix: entryPrefix(gw.id) })).blobs) await s.delete(key);
    await s.delete(gwKey(gw.id));
    return json({ ok: true });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = { path: ["/api/giveaways", "/api/giveaways/enter"] };
