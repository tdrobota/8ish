// Entitlement Credential -- the ONLY file in this repo allowed to mint or
// verify a `c1.` credential (Story 6-2, AD-15). A credential is what
// replaces a raw subscription id as the thing a client can hand back to the
// server to prove it is entitled: `checkout-confirm.js` and `restore.js`
// (from Story 6.3 on) mint one after a server-verified purchase/restore;
// `entitlement.js` verifies one, reads the subscription id ONLY from it
// (never from a request parameter), and mints a fresh one back whenever it
// answers active -- so a subscriber who opens the app regularly never sees
// the 7-day window expire.
//
// Format: `c1.<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`.
// payload = `{ sub, iat, exp, v }` -- sub is the Stripe subscription id,
// iat/exp are epoch milliseconds, v is the payload version (currently
// always 1). The HMAC covers `"c1." + base64url(payload)`, i.e. the token
// TYPE PREFIX IS PART OF THE SIGNED INPUT, not a separate field checked
// afterwards -- this is deliberate and is what makes "a device-type token
// (a future `d1.` prefix) never verifies as a `c1.` credential" a fact about
// the cryptography, not just a string-prefix check that a later refactor
// could accidentally drop: verify() below always reconstructs the signed
// input from the hardcoded `TOKEN_TYPE` constant, never from whatever
// prefix happens to be present in the token it was handed, so a validly
// -signed `d1.<payload>.<sig>` token (once Story 6.3 introduces one) would
// need a signature over `"c1." + <that payload>` to pass here, which its
// own (correctly built) `"d1."`-prefixed signature will never be.
//
// verify() does zero I/O -- no KV, no fetch, no Stripe -- by design: callers
// (entitlement.js) must be able to reject a tampered/expired/wrong-type
// credential before touching any network or storage (AD-23, "no state
// before proof"). The only thing verify() reads from `env` is the secret(s)
// themselves.
//
// Rotation: verify() accepts a signature made with either
// `env.ENTITLEMENT_SECRET` or `env.ENTITLEMENT_SECRET_PREV` (see
// docs/runbook.md 2.3) -- mint() only ever signs with the current
// `ENTITLEMENT_SECRET`.

const TOKEN_TYPE = "c1.";
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PAYLOAD_VERSION = 1;

// A real credential is always well under a few hundred characters (a small
// JSON payload plus a fixed-size base64url HMAC). This is a generous upper
// bound, checked before any decode/HMAC/parse work, so a caller handing in
// an arbitrarily large string (a naive DoS, or just a bug) is rejected for
// the cost of a length check, not the cost of hashing megabytes.
const MAX_TOKEN_LENGTH = 2048;

// Thrown by mint()/verify() when `env.ENTITLEMENT_SECRET` isn't set, so a
// caller can map it to its own "not_configured" response (fail closed --
// see the story's "Always" clause: a missing secret means both endpoints
// answer not_configured and mint nothing) distinctly from "this credential
// just doesn't verify".
export class NotConfiguredError extends Error {
  constructor() {
    super("entitlement_secret_not_configured");
    this.name = "NotConfiguredError";
  }
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns null (never throws) for input that isn't valid base64url -- a
// tampered/garbage token must fail verify() as "doesn't verify", not crash
// the request.
function base64UrlDecode(value) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const binary = atob(padded + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacSha256Base64Url(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

// Constant-time over the length of `a` -- both inputs here are always
// base64url HMAC-SHA256 digests (a fixed 43 chars), so a length mismatch
// alone (checked first, non-constant-time) leaks nothing an attacker
// couldn't already know about the algorithm's fixed output size.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireSecret(env) {
  if (!env.ENTITLEMENT_SECRET) throw new NotConfiguredError();
}

// Mints a fresh `c1.` credential for `sub` (a Stripe subscription id).
// Always signs with the CURRENT secret (never `_PREV` -- that's only ever
// accepted, not produced, so an in-progress rotation converges on the new
// secret as credentials naturally refresh).
export async function mint(env, sub) {
  requireSecret(env);
  const iat = Date.now();
  const payload = { sub, iat, exp: iat + EXPIRY_MS, v: PAYLOAD_VERSION };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signedInput = TOKEN_TYPE + payloadB64;
  const signature = await hmacSha256Base64Url(env.ENTITLEMENT_SECRET, signedInput);
  return `${signedInput}.${signature}`;
}

// Verifies `token`; returns the decoded `{ sub, iat, exp, v }` payload if
// (in order) it carries the `c1.` type, its signature matches under either
// secret, its payload parses to the expected shape, and it hasn't expired --
// or `null` if any of that fails. Never throws for a malformed/tampered
// token; only throws NotConfiguredError when `env.ENTITLEMENT_SECRET` is
// missing (checked first, before any of the above, so a misconfigured
// deploy is distinguishable from "this individual token is bad").
export async function verify(env, token) {
  requireSecret(env);

  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !token.startsWith(TOKEN_TYPE)) return null;

  const rest = token.slice(TOKEN_TYPE.length);
  const dot = rest.indexOf(".");
  if (dot === -1) return null;

  const payloadB64 = rest.slice(0, dot);
  const signatureB64 = rest.slice(dot + 1);
  if (!payloadB64 || !signatureB64 || rest.indexOf(".", dot + 1) !== -1) return null; // exactly two segments after the type prefix

  // Reconstructed strictly from the hardcoded TOKEN_TYPE constant -- never
  // from whatever prefix the token itself happened to carry (see the file
  // header comment for why that distinction is the whole point).
  const signedInput = TOKEN_TYPE + payloadB64;

  const secrets = [env.ENTITLEMENT_SECRET, env.ENTITLEMENT_SECRET_PREV].filter((s) => typeof s === "string" && s.length > 0);
  let signatureOk = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Base64Url(secret, signedInput);
    if (timingSafeEqual(expected, signatureB64)) {
      signatureOk = true;
      break;
    }
  }
  if (!signatureOk) return null;

  const payloadBytes = base64UrlDecode(payloadB64);
  if (!payloadBytes) return null;

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.iat !== "number" ||
    !Number.isFinite(payload.iat) ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.v !== PAYLOAD_VERSION
  ) {
    return null;
  }

  if (Date.now() > payload.exp) return null;

  return payload;
}
