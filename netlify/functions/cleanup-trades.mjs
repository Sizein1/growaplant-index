// Tâche planifiée (toutes les heures) : supprime les salons Discord des trades au bout de 3 jours,
// et efface les annonces expirées.
import { getStore } from "@netlify/blobs";
import { deleteChannel } from "../lib/discord.mjs";

export default async () => {
  const store = getStore({ name: "trades", consistency: "strong" });
  const now = Date.now();
  const { blobs } = await store.list({ prefix: "trade/" });
  let channels = 0, removed = 0;
  for (const { key } of blobs) {
    const trade = await store.get(key, { type: "json" });
    if (!trade) continue;
    if (trade.channelId && trade.channelDeleteAt <= now) {
      if (!(await deleteChannel(trade.channelId))) continue; // Discord indisponible : on réessaiera dans une heure
      channels++;
      await store.delete(key);
      await store.delete(`lock/${trade.id}`);
      removed++;
    } else if (trade.expiresAt <= now && !trade.channelId) {
      await store.delete(key);
      await store.delete(`lock/${trade.id}`);
      removed++;
    }
  }
  console.log(`cleanup-trades : ${channels} salon(s) supprimé(s), ${removed} annonce(s) effacée(s)`);
  return new Response("ok");
};

export const config = { schedule: "@hourly" };
