// Transform Proxy — Cloudflare Pages Function for POST /api/transform
//
// Takes a locked sketch (raw base64 PNG, no "data:" prefix) plus a prompt,
// runs it through the Workers AI image-edit model via the `env.AI` binding,
// and returns the rendered image as raw base64 PNG.
//
// This is the sole file in the repo that references `context.env.AI` — no
// provider API key or SDK is used anywhere; the binding is billed to the
// Cloudflare account directly (dashboard-configured, see architecture AD-9).

const MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";
const TIMEOUT_MS = 30000;

// Not a real secret (it ships in public client JS, see draw.js) — just
// filters out generic scanners/bots hitting this endpoint blindly. The
// actual worst-case-cost backstop is COOLDOWN_MS below: Cloudflare's free
// plan can't express an hourly rate-limit rule (10s max counting window),
// so the global cooldown is what bounds billed AI calls per hour.
const APP_TOKEN = "f73dc90199f1fa117ffc96c2ed278fc6";

// The client sends the kid-facing Challenge Prompt text as-is (e.g.
// "Desenează un monstru care mănâncă doar broccoli!") — that's an
// instruction for a child, not a style directive for an image model, so
// forwarding it verbatim produced flat/illustrative results. Wrap it in a
// realism directive here so "REAL LIFE" is the model's actual target,
// while keeping the kid-facing prompt bank (prompts.js) untouched.
function buildTransformPrompt(challengeText) {
  return (
    "Transform this child's line-drawing sketch into a vivid, photorealistic image — as if it were a real photograph, not a cartoon, illustration, or drawing. " +
    "Keep the same subject, pose, and composition as the sketch. Scene: " +
    challengeText +
    ". Natural lighting, rich color, fine realistic detail."
  );
}

// Single global Cooldown (AD-5): one fixed KV key, no per-session/per-IP
// keying, matching this single-client hobby app's scale. 6 minutes caps
// billed Workers AI calls at exactly 10/hour system-wide, regardless of
// caller count — the hard ceiling on worst-case abuse cost (deliberately
// deviates from the PRD OQ3 60-120s suggestion, chosen instead for this
// bound now that the endpoint is reachable by anyone, not just the app UI).
const COOLDOWN_MS = 360000;
const COOLDOWN_KV_KEY = "lastAttempt";

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

function base64ToBlob(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

// Defensively strip a "data:...;base64," prefix, since AD-6 forbids one in
// the response even if the model happens to include it.
function stripDataUriPrefix(value) {
  const match = /^data:[^;]*;base64,(.*)$/s.exec(value);
  return match ? match[1] : value;
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

// Records the current attempt's timestamp for the Cooldown. This must never
// be allowed to turn an otherwise-successful (or already-classified error)
// response into a different one: a transient KV write failure here is
// logged and swallowed, not propagated, so it can't sacrifice a completed
// attempt at the response stage.
async function recordAttempt(env) {
  try {
    await env.COOLDOWN_KV.put(COOLDOWN_KV_KEY, String(Date.now()));
  } catch (e) {
    console.error("Cooldown KV write failed:", e);
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
    console.error("Cooldown KV read failed:", error);
    // Fail closed on cost-control infrastructure failure: if we can't even
    // confirm the Cooldown has elapsed, don't spend money calling env.AI.
    return jsonResponse(502, {
      error: { code: "provider_error", message: "cooldown check failed" },
    });
  }

  if (last) {
    const parsed = Number(last);
    // Only treat the stored value as an active cooldown when it parses to a
    // finite number; a corrupted/unexpected value is deliberately treated
    // the same as "no prior attempt" rather than silently no-op-ing via NaN.
    if (Number.isFinite(parsed)) {
      // Clamp for clock skew: a stored timestamp in the future (skew, stale
      // value) must not produce a negative elapsed / nonsensical retry time.
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
    const { image, prompt } = await context.request.json();

    const imageBlob = base64ToBlob(image, "image/png");
    const form = new FormData();
    form.append("prompt", buildTransformPrompt(prompt));
    form.append("input_image_0", imageBlob);

    // Cloudflare's documented trick for turning a FormData into the raw
    // multipart body + content-type this model family's binding expects.
    const formResponse = new Response(form);

    const runPromise = context.env.AI.run(MODEL_ID, {
      multipart: {
        body: formResponse.body,
        contentType: formResponse.headers.get("content-type"),
      },
    });

    const result = await raceWithTimeout(runPromise, TIMEOUT_MS);

    if (typeof result?.image !== "string" || result.image.length === 0) {
      await recordAttempt(context.env);
      return jsonResponse(502, {
        error: {
          code: "provider_error",
          message: "empty or malformed model response",
        },
      });
    }

    await recordAttempt(context.env);
    return jsonResponse(200, { image: stripDataUriPrefix(result.image) });
  } catch (error) {
    console.error("Transform Proxy error:", error);
    await recordAttempt(context.env);
    if (error instanceof TimeoutError) {
      return jsonResponse(504, { error: { code: "timeout" } });
    }
    return jsonResponse(502, {
      error: { code: "provider_error", message: String(error) },
    });
  }
}
