// Song Lyrics Proxy — Cloudflare Pages Function for POST /api/song
//
// Takes a theme seed + style seed (both drawn from the fixed bank in
// sing.js — see AD note in sing-flow.js, same trust model as
// /api/transform's challenge text) and runs them through a Workers AI text
// model via the `env.AI` binding, same as transform.js. Returns generated
// Romanian lyrics as plain text.
//
// Audio generation is intentionally NOT wired here. Suno has no public
// self-serve API as of 2026 (only a curated partner-program application)
// and its ToS forbids automated/third-party access to a personal account.
// ElevenLabs Music and Google Lyria were both evaluated as alternatives —
// both work technically, but both gate the actual music-generation call
// behind real paid billing (ElevenLabs: Music API needs a paid plan even
// though the base free tier exists; Lyria via the Gemini API: a $10 minimum
// prepay purchase not covered by the Google Cloud trial credit). Revisit
// once there's a budget for one of those, or Suno's partner program opens up.

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fast";
const TIMEOUT_MS = 30000;

// Same non-secret scanner filter as transform.js — must match that literal.
const APP_TOKEN = "f73dc90199f1fa117ffc96c2ed278fc6";

// Own cooldown key so drawing and singing don't share one global clock, but
// the same worst-case-cost reasoning as transform.js applies (Cloudflare
// free plan can't express an hourly rate limit, so this is the backstop).
const COOLDOWN_MS = 90000;
const COOLDOWN_KV_KEY = "lastSongAttempt";

function buildSongPrompt(themeSeed, styleSeed) {
  return `Ești un textier priceput care scrie versuri de cântece în limba română pentru copii cu vârste între 6 și 10 ani.

Scrie versurile unui cântec ${styleSeed}, ${themeSeed}.

Reguli obligatorii:
- Scrie DOAR în limba română, cu cuvinte simple, potrivite pentru copii.
- Structură: 2 versuri (strofe) și un refren, refrenul poate apărea de două ori.
- Ton vesel, prietenos, plin de imaginație — niciodată trist, înfricoșător sau violent.
- NU menționa persoane reale, branduri, sau lucruri nepotrivite pentru copii.
- Scrie DOAR versurile, fără titlu, fără explicații, fără note suplimentare.`;
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function raceWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// Mirrors transform.js's recordAttempt: never allowed to turn a completed
// response into a different one — a KV write failure here is logged and
// swallowed, not propagated.
async function recordAttempt(env) {
  try {
    await env.COOLDOWN_KV.put(COOLDOWN_KV_KEY, String(Date.now()));
  } catch (e) {
    console.error("Song cooldown KV write failed:", e);
  }
}

export async function onRequestPost(context) {
  if (context.request.headers.get("x-app-token") !== APP_TOKEN) {
    return jsonResponse(401, { error: { code: "unauthorized" } });
  }

  let last;
  try {
    last = await context.env.COOLDOWN_KV.get(COOLDOWN_KV_KEY);
  } catch (error) {
    console.error("Song cooldown KV read failed:", error);
    // Fail closed on cost-control infrastructure failure, same as transform.js.
    return jsonResponse(502, {
      error: { code: "provider_error", message: "cooldown check failed" },
    });
  }

  if (last) {
    const parsed = Number(last);
    if (Number.isFinite(parsed)) {
      const elapsed = Math.max(0, Date.now() - parsed);
      if (elapsed < COOLDOWN_MS) {
        return jsonResponse(429, {
          error: {
            code: "cooldown",
            retryAfterSeconds: Math.ceil((COOLDOWN_MS - elapsed) / 1000),
          },
        });
      }
    }
  }

  try {
    const { themeSeed, styleSeed } = await context.request.json();

    if (typeof themeSeed !== "string" || typeof styleSeed !== "string" || !themeSeed || !styleSeed) {
      return jsonResponse(400, { error: { code: "bad_request" } });
    }

    const runPromise = context.env.AI.run(MODEL_ID, {
      messages: [{ role: "user", content: buildSongPrompt(themeSeed, styleSeed) }],
    });

    const result = await raceWithTimeout(runPromise, TIMEOUT_MS);
    const lyrics = typeof result?.response === "string" ? result.response.trim() : "";

    if (!lyrics) {
      await recordAttempt(context.env);
      return jsonResponse(502, {
        error: { code: "provider_error", message: "empty or malformed model response" },
      });
    }

    await recordAttempt(context.env);
    return jsonResponse(200, { lyrics });
  } catch (error) {
    console.error("Song Proxy error:", error);
    await recordAttempt(context.env);
    if (error instanceof TimeoutError) {
      return jsonResponse(504, { error: { code: "timeout" } });
    }
    return jsonResponse(502, {
      error: { code: "provider_error", message: String(error) },
    });
  }
}
