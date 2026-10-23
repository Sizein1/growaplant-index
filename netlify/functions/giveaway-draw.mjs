// Tâche planifiée (chaque minute) : tire au sort les giveaways terminés, supprime les salons de remise
// trop vieux (7 jours) et efface les giveaways finis depuis plus de 3 jours.
import { store, gwKey, entryPrefix, saveGiveaway, draw, KEEP_FINISHED_MS } from "../lib/giveaways.mjs";
import { deleteChannel } from "../lib/discord.mjs";

export async function runDraws(origin) {
  const s = store();
  const now = Date.now();
  const { blobs } = await s.list({ prefix: "gw/" });
  let drawn = 0;
  for (const { key } of blobs) {
    const gw = await s.get(key, { type: "json" });
    if (!gw) continue;
    try {
      if (gw.status === "active" && gw.endsAt <= now) {
        await saveGiveaway({ ...gw, status: "drawing" }); // évite un double tirage si la tâche suivante démarre pendant celle-ci
        await saveGiveaway(await draw(gw, origin));
        drawn++;
      } else if (gw.status === "drawn" && gw.channelDeleteAt <= now) {
        if (await deleteChannel(gw.channelId)) await saveGiveaway({ ...gw, status: "closed", closedAt: now });
      } else if (gw.status === "drawing" && now - gw.endsAt > 10 * 60 * 1000) {
        await saveGiveaway({ ...gw, status: "active" }); // tirage interrompu : on réessaie
      } else if (["closed", "no_participants", "rejected"].includes(gw.status) && now - (gw.closedAt || gw.finishedAt || now) > KEEP_FINISHED_MS) {
        for (const { key: entry } of (await s.list({ prefix: entryPrefix(gw.id) })).blobs) await s.delete(entry);
        await s.delete(gwKey(gw.id));
      }
    } catch (err) {
      console.error(`giveaway ${gw.id} :`, err);
      if (gw.status === "active") await saveGiveaway(gw); // remet "active" pour retenter à la prochaine minute
    }
  }
  return drawn;
}

export default async () => {
  const drawn = await runDraws(process.env.URL);
  if (drawn) console.log(`giveaway-draw : ${drawn} tirage(s)`);
  return new Response("ok");
};

export const config = { schedule: "* * * * *" };
