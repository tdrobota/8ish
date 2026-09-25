// Turnstile -- the ONLY file in this repo allowed to call Cloudflare's
// `siteverify` endpoint (Story 6-3, AD-16). Every endpoint that needs a
// human check (restore.js since Story 6-3; Story 7-6's free-Image gate,
// added below) calls into this file instead of hitting `fetch` directly, so
// the exact set of checks performed -- and the exact set deliberately NOT
// performed -- can never drift between call sites.
//
// verify(env, token, expectedAction) resolves `true` only when ALL of:
//   - `env` is itself a usable object, and env.TURNSTILE_SECRET is set
//     (either missing -> false, never a pass -- see the story's Design
//     Notes: an unconfigured Turnstile means the calling feature is
//     UNAVAILABLE, not insecure).
//   - `token` is a non-empty string.
//   - `expectedAction` is a non-empty string (a caller that forgets to pass
//     one is a bug, not a pass).
//   - Cloudflare's `siteverify` answers with `success === true`, within
//     SITEVERIFY_TIMEOUT_MS (a stalled Cloudflare endpoint must fail closed
//     promptly, not hang the caller's response indefinitely).
//   - the response's `action` field is PRESENT and equals `expectedAction`
//     exactly -- a missing `action` is a FAILURE, not a pass (an older or
//     misconfigured widget that omits it must never silently bypass this).
//   - the response's `hostname` field equals `env.ORIGIN`'s own host,
//     compared case-insensitively (DNS hostnames aren't case-sensitive, so
//     comparing raw would fail a legitimate request closed over nothing but
//     casing) -- never the request's own Host header, which a caller could
//     spoof.
//
// Deliberately never sends `remoteip`: Cloudflare's own docs say it is
// optional and its absence does not affect the verdict, and not depending
// on IP extraction here is AD-16's own decision, not an oversight.
//
// Every ambiguous outcome -- unconfigured secret, malformed response, a
// network failure or timeout, a non-2xx from Cloudflare, `env.ORIGIN` itself
// missing or unparsable -- resolves to `false`. This function never throws;
// a caller never needs a try/catch around it to stay fail-closed.
//
// Logging: exactly one fixed, short event code per DISTINCT failure
// category -- never a raw response body, error object, or the token itself
// (same rule as every other file's console.* calls in this app) --
// `turnstile_not_configured` (the secret or ORIGIN isn't set up),
// `turnstile_bad_response` (siteverify was unreachable, timed out, answered
// non-2xx, or returned unparsable JSON), `turnstile_verify_failed` (a
// genuine wrong action/hostname or an unsuccessful result). A caller
// sending a missing/empty token or action is ordinary bot-probing noise,
// not a distinct condition worth logging -- only a real misconfiguration or
// a real problem talking to Cloudflare should be distinguishable from that
// noise at the log level.
//
// Story 7-6 addition: `verifyDetailed(env, token, expectedAction)` --
// `verify()` above is purely additive-compatible with this: both now call
// ONE shared private helper (`checkTurnstile` below) that actually talks to
// `siteverify`, so there is exactly one code path doing that work, never a
// second copy of the fetch/timeout/parse logic. `verify()`'s own exported
// signature, return type (a plain boolean), and behavior are byte-for-byte
// unchanged by this refactor -- every log line above still fires from
// exactly the same condition, in the same order, with the same event code.
// `verifyDetailed()` exists because Story 7-6's free-Image gate needs to
// tell "Cloudflare's own service is unreachable" (503 `resting`, cost
// nothing, try again shortly) apart from "this token is genuinely bad" (403
// `human_check_failed`) -- a distinction `restore.js`'s plain boolean
// `verify()` has never needed and still doesn't get. Reason mapping:
//   - `not_configured`: `env`/`TURNSTILE_SECRET`/`ORIGIN` missing or
//     unusable -- the feature itself isn't set up, not a judgment on the
//     caller's token.
//   - `unreachable`: a network failure, an abort/timeout, a non-2xx status,
//     or a response body that doesn't parse as JSON -- Cloudflare's own
//     endpoint isn't answering usably.
//   - `invalid`: a missing/empty token or `expectedAction`, or a genuine
//     unsuccessful/wrong-action/wrong-hostname `siteverify` result -- the
//     service answered fine, the token itself just doesn't check out.
//   - `success`: every check passed.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// A stalled/hanging siteverify call must not hang a caller's own response
// indefinitely -- 5s is generous for a same-purpose external call while
// still failing closed promptly if Cloudflare's endpoint is unreachable.
const SITEVERIFY_TIMEOUT_MS = 5000;

// `env.ORIGIN` is a planned Worker var (docs/runbook.md 1.3/2.4). Returns
// null (fail-closed) for a missing or unparsable value rather than
// throwing, so a not-yet-configured ORIGIN just means every hostname check
// fails, not a crash. Lowercased: DNS hostnames are case-insensitive, and
// this is the single point both the expected and the echoed-back hostname
// are compared through.
function originHost(env) {
  if (typeof env.ORIGIN !== "string" || !env.ORIGIN) return null;
  try {
    return new URL(env.ORIGIN).host.toLowerCase();
  } catch {
    return null;
  }
}

// The ONE code path that actually talks to `siteverify` -- both `verify()`
// and `verifyDetailed()` below call this and nothing else does. Returns
// `{ok, reason}`; `verify()` narrows this to `.ok` alone (its unchanged
// plain-boolean contract), `verifyDetailed()` returns it as-is.
async function checkTurnstile(env, token, expectedAction) {
  // `env` itself may not even be a usable object (a caller bug, or a stray
  // undefined) -- every other check below assumes it's at least an object,
  // so this must be checked first rather than letting a property read throw.
  if (!env || typeof env !== "object") return { ok: false, reason: "not_configured" };

  if (!env.TURNSTILE_SECRET) {
    console.error("turnstile_not_configured");
    return { ok: false, reason: "not_configured" };
  }
  if (typeof token !== "string" || !token) return { ok: false, reason: "invalid" };
  if (typeof expectedAction !== "string" || !expectedAction) return { ok: false, reason: "invalid" };

  const expectedHost = originHost(env);
  if (!expectedHost) {
    console.error("turnstile_not_configured");
    return { ok: false, reason: "not_configured" };
  }

  const params = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  // No `remoteip` field -- see file header.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);

  let data;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error("turnstile_bad_response", response.status);
      return { ok: false, reason: "unreachable" };
    }
    data = await response.json();
  } catch {
    // Covers a network failure, an abort from the timeout above, and a
    // malformed (non-JSON) response body alike -- all fail closed the same
    // way, never treated as a pass.
    console.error("turnstile_bad_response");
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }

  if (!data || typeof data !== "object" || data.success !== true) {
    console.error("turnstile_verify_failed");
    return { ok: false, reason: "invalid" };
  }
  if (typeof data.action !== "string" || !data.action || data.action !== expectedAction) {
    console.error("turnstile_verify_failed");
    return { ok: false, reason: "invalid" };
  }
  if (typeof data.hostname !== "string" || data.hostname.toLowerCase() !== expectedHost) {
    console.error("turnstile_verify_failed");
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, reason: "success" };
}

export async function verify(env, token, expectedAction) {
  const result = await checkTurnstile(env, token, expectedAction);
  return result.ok;
}

export async function verifyDetailed(env, token, expectedAction) {
  return checkTurnstile(env, token, expectedAction);
}
