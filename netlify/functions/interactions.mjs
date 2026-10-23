// Clics sur les boutons du bot (Discord appelle cette adresse : "Interactions Endpoint URL" du portail).
//   gw:approve / gw:reject  -> validation d'un giveaway (rôles modérateurs uniquement)
//   gw:done                 -> "Échange effectué" : la capture du salon part dans le salon des preuves
//   gw:close                -> ferme le salon de remise
// Chaque requête est signée par Discord (Ed25519) : on la vérifie avec DISCORD_PUBLIC_KEY.
import { createPublicKey, verify } from "node:crypto";
import { isModerator, itemNames, lastImage, sendImage, deleteChannel } from "../lib/discord.mjs";
import { GW, getGiveaway, saveGiveaway, validationMessage, announce } from "../lib/giveaways.mjs";

const API = "https://discord.com/api/v10";
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

// Messages envoyés après coup (suite d'une réponse différée)
async function followUp(interaction, method, path, body) {
  if (DEV()) { console.log(`[discord simulé] suite ${method} ${path} : ${body.content || ""}`); return; }
  await fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

export default async (req, context) => {
  const raw = await req.text();
  if (!signatureOk(req, raw)) return new Response("signature invalide", { status: 401 });
  const interaction = JSON.parse(raw);
  if (interaction.type === 1) return json({ type: 1 }); // PING de vérification de Discord
  if (interaction.type !== 3) return json({ type: 4, data: { content: "?", flags: 64 } });

  const [scope, action, id] = (interaction.data?.custom_id || "").split(":");
  if (scope !== "gw") return ephemeral("Bouton inconnu.");
  const member = interaction.member || {};
  const clicker = member.user || interaction.user || {};
  const mod = isModerator(member.roles || []);
  const origin = new URL(req.url).origin;
  const later = (promise) => (context?.waitUntil ? context.waitUntil(promise) : promise); // travail après la réponse

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
    if (ok) later(announce(updated, origin).then((msgId) => saveGiveaway({ ...updated, announceMsg: msgId })).catch(console.error));
    const names = await itemNames(origin);
    return json({ type: 7, data: validationMessage(updated, names, { ok, by: clicker.id }) }); // met à jour le message
  }

  const involved = mod || clicker.id === gw.creator.id || clicker.id === gw.winner?.id;
  if (!involved) return ephemeral("Ce bouton est réservé au créateur et au gagnant. / Creator and winner only.");

  // --- "Échange effectué" : on récupère la capture et on l'envoie dans le salon des preuves ---
  if (action === "done") {
    if (gw.proofSent) return ephemeral("La preuve a déjà été envoyée. / Proof already sent.");
    const image = await lastImage(gw.channelId);
    if (!image) return ephemeral("📸 Envoie d'abord une capture d'écran de l'échange dans ce salon, puis reclique. / Post a screenshot first, then click again.");
    later((async () => {
      try {
        await sendImage(GW.proofs, {
          content: `📸 Preuve de remise du giveaway / Giveaway hand-over proof\n🎁 Créateur : <@${gw.creator.id}> · 🏆 Gagnant : <@${gw.winner.id}>`,
          allowed_mentions: { users: [gw.creator.id, gw.winner.id] },
        }, image);
        await saveGiveaway({ ...gw, proofSent: true, proofAt: Date.now() });
        await followUp(interaction, "PATCH", "/messages/@original", {
          components: [{ type: 1, components: [{ type: 2, style: 4, label: "Fermer le salon / Close channel", emoji: { name: "🔒" }, custom_id: `gw:close:${gw.id}` }] }],
        });
        await followUp(interaction, "POST", "", { content: "✅ Preuve envoyée dans le salon des preuves. Vous pouvez fermer ce salon. / Proof sent. You can close this channel." });
      } catch (err) {
        console.error(err);
        await followUp(interaction, "POST", "", { content: "❌ L'envoi de la preuve a échoué, réessaie. / Sending the proof failed, try again.", flags: 64 });
      }
    })());
    return json({ type: 6 }); // réponse différée : le travail continue juste après
  }

  // --- Fermeture du salon ---
  if (action === "close") {
    later((async () => {
      await new Promise((r) => setTimeout(r, 1500)); // laisse le message de fermeture s'afficher
      if (await deleteChannel(gw.channelId)) await saveGiveaway({ ...gw, status: "closed", closedAt: Date.now() });
    })());
    return json({ type: 4, data: { content: "🔒 Fermeture du salon… / Closing the channel…" } });
  }

  return ephemeral("Action inconnue.");
};

export const config = { path: "/api/discord/interactions" };
