// Device Token -- mints/verifies a `d1.` free-device identifier (Story 7-6,
// epic-7-context.md's AD-16: "same secret, distinct type prefix"). It
// identifies no person: just an opaque random 128-bit id a device can hand
// back to prove "the server itself minted this exact id at some point" --
// nothing more. A device that loses it (private browsing, cleared storage,
// a second device) is simply issued a fresh one on its next passed Turnstile
// check, exactly like a `c1.` credential that expired gets re-minted.
//
// Format: `d1.<base64url(16 random bytes)>.<base64url(HMAC-SHA256
// signature)>`. The HMAC covers `"d1." + idB64` -- the token TYPE PREFIX IS
// PART OF THE SIGNED INPUT, not a separate field checked afterwards,
// mirroring `functions/lib/credential.js`'s own `c1.` scheme exactly (see
// that file's header comment for the full reasoning): verify() below always
// reconstructs the signed input from the hardcoded TOKEN_TYPE constant,
// never from whatever prefix the token itself happens to carry, so a
// validly-signed `c1.` credential can never verify as a `d1.` token and
// vice versa -- a fact about the cryptography, not a string-prefix check a
// later refactor could accidentally drop. This is what makes "a `c1.`
// credential handed in as a device token is treated as no token at all"
// true by construction, not by convention.
//
// Deliberately does NOT import credential.js's own base64url/HMAC helpers --
// a small, self-contained copy lives below instead (duplicated on purpose),
// so `credential.js` (the one file in the repo allowed to mint/verify a
// `c1.` credential) is never touched by this story at all, per its own "Ask
// First" boundary.
//
// Rotation: verify() accepts a signature made with either
// `env.ENTITLEMENT_SECRET` or `env.ENTITLEMENT_SECRET_PREV` -- the SAME
// secret family `c1.` credentials use (never a separate device-token
// secret), same rotation-acceptance behavior as credential.js's own
// verify() (docs/runbook.md 2.3). mint() only ever signs with the CURRENT
// `ENTITLEMENT_SECRET`, never `_PREV`.
//
// No expiry field, unlike credential.js's 7-day `c1.` payload -- a device
// token is not time-boxed; it identifies a device for as long as that
// device keeps it (the frozen spec's own Code Map: "a simpler payload --
// just a random id, no expiry").
//
// Judgment call (flagged prominently in this story's report): this story's
// own Code Map describes only `mint(env) -> token` / `verify(env, token) ->
// {id}|null`, with no mention of a thrown "not configured" error the way
// credential.js's `NotConfiguredError` gives entitlement.js/transform.js's
// subscriber path a fail-closed branch for a missing `ENTITLEMENT_SECRET`.
// Leaving that out here would mean a missing `ENTITLEMENT_SECRET` makes
// EVERY `d1.` token forgeable (the HMAC key would derive from the literal
// string "undefined"), silently -- exactly the class of failure AD-14/
// AD-23 require this app to fail closed on instead ("a failure anywhere in
// cost control must silently deny, never silently allow, spend"). This file
// therefore mirrors credential.js's own `NotConfiguredError`/`requireSecret`
// pattern; `functions/api/transform.js` catches it the same way
// `entitlement.js`/the subscriber path already catch credential.js's own
// version, mapping it to `500 not_configured`. The mint()/verify() SUCCESS
// return shapes are exactly what the spec's Code Map describes -- only the
// misconfigured-server case gained a thrown, catchable error instead of a
// silently-insecure signature.

const TOKEN_TYPE = "d1.";
const ID_BYTES = 16; // 128 bits, per the frozen spec's Design Notes

// A real device token is always a fixed, small size (a fixed-length
// base64url id from 16 raw bytes, plus a fixed-length base64url
// HMAC-SHA256 signature) -- this generous upper bound is checked before any
// decode/HMAC work, the same discipline credential.js's own
// MAX_TOKEN_LENGTH uses, and for the same reason (a caller handing in an
// arbitrarily large string is rejected for the cost of a length check, not
// the cost of hashing megabytes).
const MAX_TOKEN_LENGTH = 512;

// Thrown by mint()/verify() when `env.ENTITLEMENT_SECRET` isn't set -- see
// the "Judgment call" note above for why this file adds this even though
// the frozen spec's own Code Map doesn't mention it.
export class NotConfiguredError extends Error {
  constructor() {
    super("entitlement_secret_not_configured");
    this.name = "NotConfiguredError";
  }
}

// --- small, self-contained base64url/HMAC helpers (duplicated from
// credential.js on purpose -- see file header) -----------------------------

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
  if (!env || typeof env !== "object" || !env.ENTITLEMENT_SECRET) throw new NotConfiguredError();
}

// Mints a fresh `d1.` device token: `crypto.getRandomValues(new
// Uint8Array(16))` (128 bits) -> base64url -> signed with the CURRENT
// `ENTITLEMENT_SECRET` (never `_PREV` -- same reasoning as credential.js's
// own mint(): an in-progress rotation converges on the new secret as
// tokens naturally get re-minted, never by mint() itself signing with the
// old one).
export async function mint(env) {
  requireSecret(env);
  const idBytes = crypto.getRandomValues(new Uint8Array(ID_BYTES));
  const idB64 = base64UrlEncode(idBytes);
  const signedInput = TOKEN_TYPE + idB64;
  const signature = await hmacSha256Base64Url(env.ENTITLEMENT_SECRET, signedInput);
  return `${signedInput}.${signature}`;
}

// Verifies `token`; returns `{id}` (the base64url device id) on success, or
// `null` for ANY failure -- wrong type prefix, malformed shape, a signature
// that doesn't match under either secret. Never throws for a malformed/
// tampered token; only throws NotConfiguredError when `ENTITLEMENT_SECRET`
// is missing (checked first, same ordering as credential.js's own
// verify()). A `c1.` credential handed in here fails the TOKEN_TYPE check
// immediately, before any HMAC work at all -- exactly the "treated as no
// token at all" behavior the frozen spec requires, and true regardless of
// how a future token type's own prefix might look.
export async function verify(env, token) {
  requireSecret(env);

  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !token.startsWith(TOKEN_TYPE)) return null;

  const rest = token.slice(TOKEN_TYPE.length);
  const dot = rest.indexOf(".");
  if (dot === -1) return null;

  const idB64 = rest.slice(0, dot);
  const signatureB64 = rest.slice(dot + 1);
  if (!idB64 || !signatureB64 || rest.indexOf(".", dot + 1) !== -1) return null; // exactly two segments after the type prefix

  // Reconstructed strictly from the hardcoded TOKEN_TYPE constant -- never
  // from whatever prefix the token itself happened to carry (see the file
  // header comment for why that distinction is the whole point).
  const signedInput = TOKEN_TYPE + idB64;

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

  // The id itself must actually decode as base64url -- mint() never
  // produces anything else, so a value that fails to decode here could only
  // be a forgery that happened to also collide on the signature check (i.e.
  // never in practice). A defensive shape check, not a reachable
  // real-world branch, mirroring credential.js's own payload-shape check
  // after its signature check passes.
  if (!base64UrlDecode(idB64)) return null;

  return { id: idB64 };
}
