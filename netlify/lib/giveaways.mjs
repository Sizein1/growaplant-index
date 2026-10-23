// Giveaways : réglages Discord, stockage et messages du bot (partagés par l'API, les boutons et le tirage).
import { getStore } from "@netlify/blobs";
import { itemNames, itemList, sendMessage, editMessage, createPrivateChannel, isMember, slug } from "./discord.mjs";

// Salons et rôle du serveur (modifiables par variables d'environnement Netlify si besoin)
export const GW = {
  validation: process.env.GW_VALIDATION_CHANNEL || "1563187152278528020", // demandes à valider (modérateurs)
  announce: process.env.GW_ANNOUNCE_CHANNEL || "1563187403135524925",     // annonces publiques
  winners: process.env.GW_WINNERS_CHANNEL || "1563187525412065371",       // gagnants
  proofs: process.env.GW_PROOFS_CHANNEL || "1563187657159217232",         // preuves de remise
  category: process.env.GW_CATEGORY || "1563186747154890802",             // salons créateur <-> gagnant
  role: process.env.GW_ROLE || "1560373233746841631",                     // rôle mentionné aux annonces
};
export const CHANNEL_LIFETIME_MS = 7 * 24 * 3600 * 1000; // salon de remise supprimé au bout de 7 jours s'il n'est pas fermé
export const KEEP_FINISHED_MS = 3 * 24 * 3600 * 1000;    // un giveaway terminé reste visible 3 jours sur le site
export const MAX_ITEMS = 4;

export const store = () => getStore({ name: "giveaways", consistency: "strong" });
export const gwKey = (id) => `gw/${id}`;
export const entryPrefix = (id) => `entry/${id}/`;

export async function getGiveaway(id) { return store().get(gwKey(id), { type: "json" }); }
export async function saveGiveaway(gw) { await store().setJSON(gwKey(gw.id), gw); }

export async function participants(id) {
  const s = store();
  const { blobs } = await s.list({ prefix: entryPrefix(id) });
  const list = [];
  for (const { key } of blobs) {
    const entry = await s.get(key, { type: "json" });
    if (entry) list.push({ id: key.slice(entryPrefix(id).length), ...entry });
  }
  return list;
}

const siteUrl = (origin) => `${origin || process.env.URL || "https://index-gap.netlify.app"}/giveaways.html`;
const lots = (names, gw) => itemList(names, gw.items);

// Message dans le salon de validation, avec les boutons ✅ / ❌ (ou le résultat une fois traité)
export function validationMessage(gw, names, outcome) {
  const fields = [
    { name: "🎁 Lots / Prizes", value: lots(names, gw), inline: true },
    { name: "⏱ Durée / Duration", value: `${gw.hours} h`, inline: true },
    { name: "🎮 Roblox", value: gw.roblox, inline: true },
  ];
  if (gw.note) fields.push({ name: "💬 Message", value: gw.note.slice(0, 1000), inline: false });
  const embed = { title: "Nouveau giveaway à valider / New giveaway to review", color: outcome ? (outcome.ok ? 0x38b84c : 0xd23b3b) : 0xf0b020, fields };
  return {
    content: outcome
      ? `${outcome.ok ? "✅ Validé" : "❌ Refusé"} par <@${outcome.by}> — giveaway de <@${gw.creator.id}>`
      : `🎁 Giveaway proposé par <@${gw.creator.id}> (${gw.creator.name})`,
    embeds: [embed],
    components: outcome ? [] : [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Valider", emoji: { name: "✅" }, custom_id: `gw:approve:${gw.id}` },
        { type: 2, style: 4, label: "Refuser", emoji: { name: "❌" }, custom_id: `gw:reject:${gw.id}` },
      ],
    }],
    allowed_mentions: { parse: [] }, // pas de notification dans le salon de validation
  };
}

export async function postValidation(gw, origin) {
  const names = await itemNames(origin);
  return sendMessage(GW.validation, validationMessage(gw, names));
}

export async function markReviewed(gw, origin, ok, by) {
  const names = await itemNames(origin);
  if (gw.validationMsg) await editMessage(GW.validation, gw.validationMsg, validationMessage(gw, names, { ok, by }));
}

// Annonce publique d'un giveaway validé, avec mention du rôle Giveaway
export async function announce(gw, origin) {
  const names = await itemNames(origin);
  const end = Math.floor(gw.endsAt / 1000);
  return sendMessage(GW.announce, {
    content: `<@&${GW.role}> 🎉 **Nouveau giveaway de ${gw.creator.name} !** / New giveaway!\n` +
      `Participe sur le site / Enter on the site : ${siteUrl(origin)}\n⏳ Tirage <t:${end}:R> (<t:${end}:f>)`,
    embeds: [{ title: "🎁 Lots / Prizes", description: lots(names, gw), color: 0xf0b020 }],
    allowed_mentions: { roles: [GW.role] },
  });
}

// Tirage : gagnant au hasard parmi les participants encore sur le serveur, puis salon de remise
export async function draw(gw, origin) {
  const names = await itemNames(origin);
  const pool = (await participants(gw.id)).filter((p) => p.id !== gw.creator.id);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  let winner = null;
  for (const p of pool) { if (await isMember(p.id)) { winner = p; break; } }

  if (!winner) {
    await sendMessage(GW.winners, {
      content: `😕 Le giveaway de <@${gw.creator.id}> s'est terminé sans participant. / The giveaway ended with no entries.`,
      allowed_mentions: { users: [gw.creator.id] },
    });
    return { ...gw, status: "no_participants", finishedAt: Date.now(), entries: pool.length };
  }

  const deleteAt = Date.now() + CHANNEL_LIFETIME_MS;
  const channel = await createPrivateChannel({
    name: `giveaway-${slug(gw.creator.name)}-${slug(winner.name)}`, memberIds: [gw.creator.id, winner.id],
    parentId: GW.category, topic: "Remise d'un giveaway du site Index Grow a Plant",
  });
  await sendMessage(channel.id, {
    content: `🎉 <@${winner.id}> <@${gw.creator.id}>\n**${winner.name}** a gagné le giveaway de **${gw.creator.name}** ! / won the giveaway!\n` +
      `1. Organisez la remise ici, puis faites l'échange dans le jeu. / Arrange the hand-over here, then trade in game.\n` +
      `2. Envoyez une **capture d'écran** de l'échange dans ce salon. / Post a **screenshot** of the trade in this channel.\n` +
      `3. Cliquez sur **Échange effectué**. / Click **Trade done**.\n` +
      `⏳ Sans action, ce salon sera supprimé <t:${Math.floor(deleteAt / 1000)}:R>. / Otherwise this channel is deleted <t:${Math.floor(deleteAt / 1000)}:R>.`,
    embeds: [{
      title: "🎁 Lots / Prizes", description: lots(names, gw), color: 0x38b84c,
      fields: [{ name: "🎮 Roblox", value: `${gw.creator.name} : **${gw.roblox}**`, inline: false }],
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: "Échange effectué / Trade done", emoji: { name: "✅" }, custom_id: `gw:done:${gw.id}` }] }],
    allowed_mentions: { users: [gw.creator.id, winner.id] },
  });
  await sendMessage(GW.winners, {
    content: `🎉 Félicitations <@${winner.id}> ! Tu as gagné le giveaway de <@${gw.creator.id}>. / Congratulations, you won!\n${lots(names, gw)}`,
    allowed_mentions: { users: [winner.id, gw.creator.id] },
  });
  return {
    ...gw, status: "drawn", finishedAt: Date.now(), entries: pool.length,
    winner: { id: winner.id, name: winner.name }, channelId: channel.id, channelDeleteAt: deleteAt,
  };
}
