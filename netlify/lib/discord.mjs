// Actions du bot Discord : vérifier qu'un joueur est sur le serveur, créer / supprimer un salon de trade privé.
// En test local sans DISCORD_BOT_TOKEN, tout est simulé (aucun appel à Discord).

const API = "https://discord.com/api/v10";
const SIMULATED = () => !process.env.DISCORD_BOT_TOKEN && process.env.NETLIFY_DEV === "true";

// Permissions Discord (bits)
const VIEW = 1n << 10n, SEND = 1n << 11n, EMBED = 1n << 14n, ATTACH = 1n << 15n, HISTORY = 1n << 16n, MANAGE_CHANNELS = 1n << 4n;
const MEMBER_PERMS = String(VIEW | SEND | EMBED | ATTACH | HISTORY);
const BOT_PERMS = String(VIEW | SEND | EMBED | ATTACH | HISTORY | MANAGE_CHANNELS);

// Rôles qui voient tous les salons de trade (modérateurs)
const modRoles = () => (process.env.DISCORD_MOD_ROLES || "1560025359322321076,1560027613320183839")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 429) { // limite de Discord : on attend le délai demandé, une fois
    const wait = Number((await res.json().catch(() => ({}))).retry_after || 1);
    await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
    return api(path, options);
  }
  return res;
}

export async function isMember(userId) {
  if (SIMULATED()) return true;
  const res = await api(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}`);
  return res.ok;
}

// Noms des pets pour le message du salon, lus dans pets-data.js du site
async function petNames(origin) {
  try {
    const js = await (await fetch(`${origin}/pets-data.js`)).text();
    const pets = JSON.parse(js.slice(js.indexOf("["), js.lastIndexOf("]") + 1));
    return new Map(pets.map((p) => [`pet:${p.id}`, p.name]));
  } catch { return new Map(); }
}

const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "joueur";

// Crée le salon privé : visible par les 2 joueurs, les modérateurs et le bot ; caché pour @everyone
export async function createTradeChannel(trade, accepter, origin, deleteAt) {
  const name = `trade-${slug(trade.author.name)}-${slug(accepter.name)}`.slice(0, 90);
  if (SIMULATED()) return { id: `simule-${Date.now()}`, name };

  const guild = process.env.DISCORD_GUILD_ID;
  const overwrites = [
    { id: guild, type: 0, deny: String(VIEW) },                                  // @everyone : rien
    { id: trade.author.id, type: 1, allow: MEMBER_PERMS },
    { id: accepter.id, type: 1, allow: MEMBER_PERMS },
    { id: process.env.DISCORD_CLIENT_ID, type: 1, allow: BOT_PERMS },           // le bot lui-même
    ...modRoles().map((id) => ({ id, type: 0, allow: MEMBER_PERMS })),
  ];
  const res = await api(`/guilds/${guild}/channels`, {
    method: "POST",
    body: JSON.stringify({
      name, type: 0, permission_overwrites: overwrites,
      ...(process.env.DISCORD_CATEGORY_ID ? { parent_id: process.env.DISCORD_CATEGORY_ID } : {}),
      topic: "Salon de trade créé depuis le site Index Grow a Plant",
    }),
  });
  if (!res.ok) throw new Error(`création du salon : ${res.status} ${await res.text()}`);
  const channel = await res.json();

  // Message d'accueil : mentionne les deux joueurs, résume le trade (FR + EN)
  const names = await petNames(origin);
  const list = (refs) => refs.length ? refs.map((r) => `• ${names.get(r) || r.replace("pet:", "")}`).join("\n") : "—";
  const ts = Math.floor(deleteAt / 1000);
  const fields = [];
  if (trade.kind === "offer") fields.push({ name: `🎁 ${trade.author.name} offre / offers`, value: list(trade.have), inline: true });
  fields.push({ name: `🔎 ${trade.author.name} veut / wants`, value: list(trade.want), inline: true });
  fields.push({ name: "🎮 Roblox", value: `${trade.author.name} : **${trade.roblox}**`, inline: false });
  if (trade.note) fields.push({ name: "💬 Message", value: trade.note.slice(0, 1000), inline: false });
  await api(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: `🤝 <@${trade.author.id}> <@${accepter.id}>\n**${accepter.name}** a accepté le trade de **${trade.author.name}** ! / accepted the trade!\n` +
        `Mettez-vous d'accord ici, puis faites l'échange dans le jeu. / Agree here, then trade in game.\n` +
        `⏳ Ce salon sera supprimé <t:${ts}:R>. / This channel will be deleted <t:${ts}:R>.`,
      embeds: [{ title: "Trade", color: 0x38b84c, fields }],
      allowed_mentions: { users: [trade.author.id, accepter.id] },
    }),
  });
  return { id: channel.id, name };
}

export async function deleteChannel(channelId) {
  if (SIMULATED() || String(channelId).startsWith("simule-")) return true;
  const res = await api(`/channels/${channelId}`, { method: "DELETE" });
  return res.ok || res.status === 404; // déjà supprimé à la main : c'est bon aussi
}

export const channelUrl = (channelId) => `https://discord.com/channels/${process.env.DISCORD_GUILD_ID || "0"}/${channelId}`;
