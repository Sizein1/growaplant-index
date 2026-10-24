// Clics sur les boutons du bot (Discord appelle cette adresse : "Interactions Endpoint URL" du portail).
//   gw:approve / gw:reject  -> validation d'un giveaway (rôles modérateurs uniquement)
//   gw:done                 -> "Échange effectué" : la capture du salon part dans le salon des preuves
//   gw:close                -> ferme le salon de remise
//   tr:cancel               -> trade annulé : salon fermé, l'annonce redevient disponible sur le site
//   tr:done                 -> trade terminé : salon fermé, annonce supprimée
// Chaque requête est signée par Discord (Ed25519) : on la vérifie avec DISCORD_PUBLIC_KEY.
import { createPublicKey, verify } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { isModerator, itemNames, lastImage, sendImage, sendMessage, deleteChannel } from "../lib/discord.mjs";
import { GW, getGiveaway, saveGiveaway, validationMessage, announce } from "../lib/giveaways.mjs";

const DEV = () => process.env.NETLIFY_DEV === "true" && !process.env.DISCORD_PUBLIC_KEY; // test local : pas de signature
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ephemeral = (content) => json({ type: 4, data: { content, flags: 64 } }); // réponse visible seulement par celui qui clique

function signatureOk(req, raw) {
  if (DEV()) return true;
  try {
    const sig = req.headers.get("x-signature-ed25519") || "";
    const ts = req.headers.get("x-signature-timestamp") || "";
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(process.env.DISCORD_PUBLIC_KEY, "hex")]),
      format: "der", type: "spki",
    });
    return verify(null, Buffer.from(ts + raw), key, Buffer.from(sig, "hex"));
  } catch { return false; }
}

// Important : sur Netlify, la fonction s'arrête dès qu'elle a répondu. Tout le travail (annonce, preuve,
// suppression du salon) est donc fait AVANT de répondre à Discord, qui laisse 3 secondes.
export default async (req) => {
  const raw = await req.text();
  if (!signatureOk(req, raw)) return new Response("signature invalide", { status: 401 });
  const interaction = JSON.parse(raw);
  if (interaction.type === 1) return json({ type: 1 }); // PING de vérification de Discord
  if (interaction.type !== 3) return json({ type: 4, data: { content: "?", flags: 64 } });

  const [scope, action, id] = (interaction.data?.custom_id || "").split(":");
  const member = interaction.member || {};
  const clicker = member.user || interaction.user || {};
  const mod = isModerator(member.roles || []);
  const origin = new URL(req.url).origin;
  if (scope === "tr") return tradeButton(action, id, clicker, mod);
  if (scope !== "gw") return ephemeral("Bouton inconnu.");

  const gw = await getGiveaway(id);
  if (!gw) return ephemeral("Ce giveaway n'existe plus. / This giveaway no longer exists.");

  // --- Validation par un modérateur ---
  if (action === "approve" || action === "reject") {
    if (!mod) return ephemeral("Seuls les modérateurs peuvent valider. / Moderators only.");
    if (gw.status !== "pending") return ephemeral("Déjà traité. / Already reviewed.");
    const ok = action === "approve";
    const now = Date.now();
    // Test local uniquement : GW_TEST_SECONDS raccourcit la durée pour tester le tirage sans attendre une heure
    const duration = DEV() && process.env.GW_TEST_SECONDS ? Number(process.env.GW_TEST_SECONDS) * 1000 : gw.hours * 3600 * 1000;
    const updated = ok
      ? { ...gw, status: "active", reviewedBy: clicker.id, startsAt: now, endsAt: now + duration }
      : { ...gw, status: "rejected", reviewedBy: clicker.id, finishedAt: now };
    await saveGiveaway(updated);
    if (ok) {
      // Annonce publique ; si Discord échoue ici, la tâche de chaque minute la renverra (giveaway sans announceMsg)
      try { await saveGiveaway({ ...updated, announceMsg: await announce(updated, origin) }); } catch (err) { console.error("annonce :", err); }
    }
    const names = await itemNames(origin);
    return json({ type: 7, data: validationMessage(updated, names, { ok, by: clicker.id }) }); // met à jour le message
  }

  const involved = mod || clicker.id === gw.creator.id || clicker.id === gw.winner?.id;
  if (!involved) return ephemeral("Ce bouton est réservé au créateur et au gagnant. / Creator and winner only.");

  // --- "Échange effectué" : on récupère la capture et on l'envoie dans le salon des preuves ---
  // Bouton "Fermer le salon" : envoyé dans un NOUVEAU message, pas dans la réponse au clic, car copier
  // la preuve prend souvent plus de 3 s et Discord ignore alors la réponse (le bouton n'apparaissait pas).
  const closeRow = [{ type: 1, components: [{ type: 2, style: 4, label: "Fermer le salon / Close channel", emoji: { name: "🔒" }, custom_id: `gw:close:${gw.id}` }] }];

  if (action === "done") {
    // Déjà envoyée : on redonne le bouton (visible seulement par celui qui clique), utile si le message a été perdu
    if (gw.proofSent) return json({ type: 4, data: { content: "La preuve a déjà été envoyée. / Proof already sent.", components: closeRow, flags: 64 } });
    const image = await lastImage(gw.channelId);
    if (!image) return ephemeral("📸 Envoie d'abord une capture d'écran de l'échange dans ce salon, puis reclique. / Post a screenshot first, then click again.");
    try {
      await sendImage(GW.proofs, {
        content: `📸 Preuve de remise du giveaway / Giveaway hand-over proof\n🎁 Créateur : <@${gw.creator.id}> · 🏆 Gagnant : <@${gw.winner.id}>`,
        allowed_mentions: { users: [gw.creator.id, gw.winner.id] },
      }, image);
    } catch (err) {
      console.error(err);
      return ephemeral("❌ L'envoi de la preuve a échoué, réessaie. / Sending the proof failed, try again.");
    }
    await saveGiveaway({ ...gw, proofSent: true, proofAt: Date.now() });
    await sendMessage(gw.channelId, {
      content: "✅ Preuve envoyée dans le salon des preuves. Vous pouvez fermer ce salon. / Proof sent. You can close this channel.",
      components: closeRow,
    }).catch(console.error);
    return json({ type: 6 }); // accusé de réception (souvent trop tard pour Discord, sans conséquence)
  }

  // --- Fermeture du salon ---
  if (action === "close") {
    if (await deleteChannel(gw.channelId)) {
      await saveGiveaway({ ...gw, status: "closed", closedAt: Date.now() });
      return json({ type: 6 }); // le salon n'existe plus : simple accusé de réception
    }
    return ephemeral("❌ Impossible de fermer le salon, réessaie. / Could not close the channel, try again.");
  }

  return ephemeral("Action inconnue.");
};

// --- Boutons du salon d'un trade accepté (auteur, joueur qui a accepté, ou modérateur) ---
const DAY_MS = 24 * 3600 * 1000;
async function tradeButton(action, id, clicker, mod) {
  const store = getStore({ name: "trades", consistency: "strong" });
  const key = `trade/${id}`;
  const found = await store.getWithMetadata(key, { type: "json" });
  const trade = found?.data;
  if (!trade) return ephemeral("Ce trade n'existe plus. / This trade no longer exists.");
  if (!mod && clicker.id !== trade.author.id && clicker.id !== trade.acceptedBy?.id) return ephemeral("Bouton réservé aux deux joueurs du trade. / Trade members only.");
  if (trade.status !== "in_progress") return ephemeral("Déjà traité. / Already handled.");
  if (action !== "cancel" && action !== "done") return ephemeral("Action inconnue.");

  // Salon supprimé d'abord : si Discord échoue, rien n'a changé et on peut recliquer
  if (!(await deleteChannel(trade.channelId))) return ephemeral("❌ Impossible de fermer le salon, réessaie. / Could not close the channel, try again.");
  if (action === "done") {
    await store.delete(key);
  } else {
    // L'annonce revient telle qu'avant l'acceptation, avec au moins un jour devant elle
    const { acceptedBy, channelId, acceptedAt, channelDeleteAt, openExpiresAt, ...listing } = trade;
    await store.setJSON(key, { ...listing, status: "open", expiresAt: Math.max(openExpiresAt || 0, Date.now() + DAY_MS) }, { onlyIfMatch: found.etag });
  }
  await store.delete(`lock/${id}`); // l'annonce peut être acceptée à nouveau
  return json({ type: 6 }); // le salon n'existe plus : simple accusé de réception
}

export const config = { path: "/api/discord/interactions" };
