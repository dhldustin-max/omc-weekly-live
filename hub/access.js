// Who is signed in, from Cloudflare Access. Access sits in front of the whole site and adds a signed
// JWT (Cf-Access-Jwt-Assertion); we verify it against the team's public keys and the app's AUD tag.
let KEYS = null, KEYS_AT = 0;

async function keys(team) {
  if (KEYS && Date.now() - KEYS_AT < 3600e3) return KEYS;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  KEYS = (await r.json()).keys; KEYS_AT = Date.now();
  return KEYS;
}
const b64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));

export async function accessEmail(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt || !env.TEAM || !env.AUD) return null;
  const [h, p, sig] = jwt.split(".");
  const head = JSON.parse(new TextDecoder().decode(b64url(h))), body = JSON.parse(new TextDecoder().decode(b64url(p)));
  const jwk = (await keys(env.TEAM)).find(k => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
  const aud = [].concat(body.aud);
  if (!ok || !aud.includes(env.AUD) || body.exp * 1000 < Date.now()) return null;
  return String(body.email || "").toLowerCase() || null;
}
