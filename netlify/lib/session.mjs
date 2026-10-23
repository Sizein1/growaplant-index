// Session "connecté avec Discord" : un cookie signé (HMAC) qui contient l'identifiant et le nom Discord.
// Personne ne peut le fabriquer ou le modifier sans SESSION_SECRET (variable d'environnement Netlify).
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "gap_session";
const MAX_AGE = 30 * 24 * 3600; // 30 jours

const secret = () => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NETLIFY_DEV === "true") return "secret-de-test-local"; // uniquement en test sur le PC
  throw new Error("SESSION_SECRET manquant");
};
const sign = (data) => createHmac("sha256", secret()).update(data).digest("base64url");

export function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function cookie(name, value, maxAge, req) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// Utilisateur connecté, ou null
export function getUser(req) {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const [data, sig] = raw.split(".");
  if (!data || !sig) return null;
  const expected = Buffer.from(sign(data));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const user = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return user.exp > Date.now() ? user : null;
  } catch {
    return null;
  }
}

export function sessionCookie(user, req) {
  const data = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  return cookie(COOKIE, `${data}.${sign(data)}`, MAX_AGE, req);
}

export const clearSessionCookie = (req) => cookie(COOKIE, "", 0, req);
