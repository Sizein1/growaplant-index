// Connexion avec Discord (OAuth2, droit "identify" seulement : identifiant et nom, rien d'autre).
//   /api/auth/login     -> envoie vers Discord
//   /api/auth/callback  -> retour de Discord : crée la session
//   /api/auth/me        -> qui est connecté (+ lien d'invitation du serveur)
//   /api/auth/logout    -> déconnexion
//   /api/auth/dev-login -> connexion factice, UNIQUEMENT en test local (netlify dev)
import { randomBytes } from "node:crypto";
import { getUser, sessionCookie, clearSessionCookie, readCookie, cookie } from "../lib/session.mjs";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const redirect = (location, cookies = []) => {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
};

export default async (req, context) => {
  const url = new URL(req.url);
  const action = context.params?.action;
  const redirectUri = `${url.origin}/api/auth/callback`;

  if (action === "login") {
    const state = randomBytes(16).toString("hex"); // protège contre les connexions forcées
    const auth = new URL("https://discord.com/oauth2/authorize");
    auth.search = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID || "", response_type: "code", scope: "identify",
      redirect_uri: redirectUri, state, prompt: "none",
    });
    return redirect(auth.toString(), [cookie("gap_state", state, 600, req)]);
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== readCookie(req, "gap_state")) return redirect("/trades.html?login=error");
    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return redirect("/trades.html?login=error");
    const { access_token } = await tokenRes.json();
    const meRes = await fetch("https://discord.com/api/v10/users/@me", { headers: { authorization: `Bearer ${access_token}` } });
    if (!meRes.ok) return redirect("/trades.html?login=error");
    const me = await meRes.json();
    const user = { id: me.id, name: me.global_name || me.username, username: me.username };
    return redirect("/trades.html", [sessionCookie(user, req), cookie("gap_state", "", 0, req)]);
  }

  if (action === "me") {
    const user = getUser(req);
    return json({
      user: user && { id: user.id, name: user.name, username: user.username },
      invite: process.env.DISCORD_INVITE || "",
      guildId: process.env.DISCORD_GUILD_ID || "", // pour le lien "Ouvrir le salon" (identifiant public)
    });
  }

  if (action === "logout") return redirect("/trades.html", [clearSessionCookie(req)]);

  // Test local uniquement : se connecter sous un faux compte (?id=...&name=...) sans passer par Discord
  if (action === "dev-login" && process.env.NETLIFY_DEV === "true") {
    const user = { id: url.searchParams.get("id") || "111", name: url.searchParams.get("name") || "Testeur", username: "testeur" };
    return redirect("/trades.html", [sessionCookie(user, req)]);
  }

  return json({ error: "not_found" }, 404);
};

export const config = { path: "/api/auth/:action" };
