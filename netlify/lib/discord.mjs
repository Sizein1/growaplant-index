// Actions du bot Discord : membres, salons privés (trades, giveaways), messages, images de preuve.
// En test local sans DISCORD_BOT_TOKEN, tout est simulé (aucun appel à Discord, actions écrites dans le journal).

const API = "https://discord.com/api/v10";
const SIMULATED = () => !process.env.DISCORD_BOT_TOKEN && process.env.NETLIFY_DEV === "true";

// Permissions Discord (bits)
const VIEW = 1n << 10n, SEND = 1n << 11n, EMBED = 1n << 14n, ATTACH = 1n << 15n, HISTORY = 1n << 16n, MANAGE_CHANNELS = 1n << 4n;
const MEMBER_PERMS = String(VIEW | SEND | EMBED | ATTACH | HISTORY);
const BOT_PERMS = String(VIEW | SEND | EMBED | ATTACH | HISTORY | MANAGE_CHANNELS);

// Rôles qui voient tous les salons de trade (modérateurs)
const modRoles = () => (process.env.DISCORD_MOD_ROLES || "1560025359322321076,1560027613320183839")
  .split(",").map((s) => s.trim()).filter(Boolean);

export async function api(path, options = {}) {
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

// Noms des pets et des œufs pour les messages, lus dans pets-data.js et eggs-data.js du site
export async function itemNames(origin) {
  const names = new Map();
  for (const [file, prefix, label] of [["pets-data.js", "pet", ""], ["eggs-data.js", "egg", "🥚 "]]) {
    try {
      const js = await (await fetch(`${origin}/${file}`)).text();
      const list = JSON.parse(js.slice(js.indexOf("["), js.lastIndexOf("]") + 1));
      for (const x of list) names.set(`${prefix}:${x.id}`, label + x.name);
    } catch { /* fichier absent : on affichera l'identifiant */ }
  }
  return names;
}

export const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "joueur";
export const isModerator = (roleIds = []) => roleIds.some((r) => modRoles().includes(r));
export const itemList = (names, refs) => refs.length ? refs.map((r) => `• ${names.get(r) || r.split(":")[1]}`).join("\n") : "—";

// Salon privé : visible par les membres donnés, les modérateurs et le bot ; caché pour @everyone
export async function createPrivateChannel({ name, memberIds, parentId, topic }) {
  name = name.slice(0, 90);
  if (SIMULATED()) { console.log(`[discord simulé] salon privé #${name} pour ${memberIds.join(", ")}`); return { id: `simule-${Date.now()}`, name }; }
  const guild = process.env.DISCORD_GUILD_ID;
  const overwrites = [
    { id: guild, type: 0, deny: String(VIEW) },                                  // @everyone : rien
    ...memberIds.map((id) => ({ id, type: 1, allow: MEMBER_PERMS })),
    { id: process.env.DISCORD_CLIENT_ID, type: 1, allow: BOT_PERMS },           // le bot lui-même
    ...modRoles().map((id) => ({ id, type: 0, allow: MEMBER_PERMS })),
  ];
  const res = await api(`/guilds/${guild}/channels`, {
    method: "POST",
    body: JSON.stringify({ name, type: 0, permission_overwrites: overwrites, topic, ...(parentId ? { parent_id: parentId } : {}) }),
  });
  if (!res.ok) throw new Error(`création du salon : ${res.status} ${await res.text()}`);
  const channel = await res.json();
  return { id: channel.id, name };
}

// Envoie un message ; renvoie son identifiant
export async function sendMessage(channelId, body) {
  if (SIMULATED() || String(channelId).startsWith("simule-")) {
    console.log(`[discord simulé] message dans ${channelId} : ${(body.content || "").replace(/\n/g, " ").slice(0, 200)}`);
    return `simule-msg-${Date.now()}`;
  }
  const res = await api(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`message : ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

export async function editMessage(channelId, messageId, body) {
  if (SIMULATED() || String(messageId).startsWith("simule-")) { console.log(`[discord simulé] message ${messageId} modifié`); return; }
  await api(`/channels/${channelId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify(body) });
}

// Dernière image postée dans un salon (capture d'écran de preuve) : { url, filename, contentType } ou null
export async function lastImage(channelId) {
  if (SIMULATED() || String(channelId).startsWith("simule-")) return process.env.SIM_NO_IMAGE ? null : { url: "https://example.com/preuve.png", filename: "preuve.png", contentType: "image/png" };
  const res = await api(`/channels/${channelId}/messages?limit=50`);
  if (!res.ok) return null;
  for (const message of await res.json()) { // du plus récent au plus ancien
    if (message.author?.bot) continue;
    const img = (message.attachments || []).find((a) => (a.content_type || "").startsWith("image/"));
    if (img) return { url: img.url, filename: img.filename, contentType: img.content_type };
  }
  return null;
}

// Republie une image (téléchargée puis renvoyée en pièce jointe : le lien d'origine expire chez Discord)
export async function sendImage(channelId, body, image) {
  if (SIMULATED()) { console.log(`[discord simulé] image ${image.filename} dans ${channelId} : ${body.content}`); return; }
  const file = await (await fetch(image.url)).arrayBuffer();
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ ...body, attachments: [{ id: 0, filename: image.filename }] }));
  form.append("files[0]", new Blob([file], { type: image.contentType }), image.filename);
  const res = await fetch(`${API}/channels/${channelId}/messages`, { method: "POST", headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` }, body: form });
  if (!res.ok) throw new Error(`image : ${res.status} ${await res.text()}`);
}

// Salon privé d'un trade accepté, avec son message d'accueil
export async function createTradeChannel(trade, accepter, origin, deleteAt) {
  const channel = await createPrivateChannel({
    name: `trade-${slug(trade.author.name)}-${slug(accepter.name)}`, memberIds: [trade.author.id, accepter.id],
    parentId: process.env.DISCORD_CATEGORY_ID, topic: "Salon de trade créé depuis le site Index Grow a Plant",
  });

  // Message d'accueil : mentionne les deux joueurs, résume le trade (FR + EN)
  const names = await itemNames(origin);
  const ts = Math.floor(deleteAt / 1000);
  const fields = [];
  if (trade.kind === "offer") fields.push({ name: `🎁 ${trade.author.name} offre / offers`, value: itemList(names, trade.have), inline: true });
  fields.push({ name: `🔎 ${trade.author.name} veut / wants`, value: itemList(names, trade.want), inline: true });
  if (trade.kind === "request") { // recherche : ce qui est proposé en échange, s'il y a quelque chose
    fields.push({ name: "🎁 En échange / In exchange", value: trade.have.length ? itemList(names, trade.have) : "À discuter / Open to offers", inline: true });
  }
  fields.push({ name: "🎮 Roblox", value: `${trade.author.name} : **${trade.roblox}**`, inline: false });
  if (trade.note) fields.push({ name: "💬 Message", value: trade.note.slice(0, 1000), inline: false });
  await sendMessage(channel.id, {
    content: `🤝 <@${trade.author.id}> <@${accepter.id}>\n**${accepter.name}** a accepté le trade de **${trade.author.name}** ! / accepted the trade!\n` +
      `Mettez-vous d'accord ici, puis faites l'échange dans le jeu. / Agree here, then trade in game.\n` +
      `⏳ Ce salon sera supprimé <t:${ts}:R>. / This channel will be deleted <t:${ts}:R>.`,
    embeds: [{ title: "Trade", color: 0x38b84c, fields }],
    allowed_mentions: { users: [trade.author.id, accepter.id] },
  });
  return channel;
}

export async function deleteChannel(channelId) {
  if (SIMULATED() || String(channelId).startsWith("simule-")) { console.log(`[discord simulé] salon ${channelId} supprimé`); return true; }
  const res = await api(`/channels/${channelId}`, { method: "DELETE" });
  return res.ok || res.status === 404; // déjà supprimé à la main : c'est bon aussi
}

export const channelUrl = (channelId) => `https://discord.com/channels/${process.env.DISCORD_GUILD_ID || "0"}/${channelId}`;
