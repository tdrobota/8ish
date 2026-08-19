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
// instruction for a child, not a style directive for an image model. A
// first "make it photorealistic" wrap made results realistic but flattened
// out the kid's actual drawing (the model substituted its own generic
// interpretation of the challenge instead of preserving the sketch), which
// isn't what CAP-6 wants: the Rendered Art should still be recognizably
// *this drawing*, brought to life. This template makes the sketch the
// primary source and the challenge text only context, and explicitly tells
// the model to keep — not correct — the sketch's own weird/funny choices.
function buildTransformPrompt(challengeText) {
  return `You are a creative 3D artist who transforms children's sketches into realistic, funny 3D creations.

I will provide you with TWO things:

1. **THE CHALLENGE:** a short instruction describing what I was asked to draw.
2. **MY SKETCH:** a simple hand-drawn sketch created in response to that challenge.

Your job is to transform my sketch into a **realistic 3D version**, while preserving the original idea, personality, and important visual elements of the drawing.

### IMPORTANT RULES

* First, read and understand the challenge.
* Then carefully analyze my sketch.
* The sketch is the PRIMARY SOURCE for what the final object should look like.
* Do NOT replace my idea with a completely different or more conventional interpretation of the challenge.
* Keep the recognizable shapes, proportions, details, imperfections, and funny elements from my drawing.
* If something in the sketch is strange, impossible, exaggerated, or badly drawn, KEEP IT — reinterpret it creatively as a real 3D object rather than correcting it.
* Preserve the child's creative decisions.
* Turn simple lines and shapes into believable materials, surfaces, textures, depth, shadows, and 3D forms.
* Make the result look like a real physical object that could exist in the real world.
* The final result should be playful, charming, humorous, and slightly absurd when the original drawing is humorous.
* Do not make the result boring, generic, or overly polished.
* Do not add unnecessary elements that were not suggested by the sketch.
* Do not simply trace the drawing or make it look like a clean digital illustration.
* The final image should feel like **"someone brought this crazy drawing to life."**

### CREATIVE INTERPRETATION

Use the challenge to understand the intended concept, but use the sketch to determine the specific design.

For example:

Challenge: **"Draw a funny hat."**

If the sketch shows a hat with enormous ears, tiny wheels, three feathers, crooked eyes, or other strange features, the final 3D version should faithfully incorporate those features.

Do NOT turn it into a normal realistic hat just because that would make more sense.

Instead, imagine:

**"What would this exact strange drawing look like if it were a real object?"**

### VISUAL STYLE

Create a high-quality, realistic 3D render of the transformed object.

* believable materials and textures
* realistic lighting
* natural shadows
* convincing depth and volume
* detailed surface imperfections
* cinematic but playful presentation
* slightly exaggerated proportions when present in the sketch
* funny and visually appealing
* looks like a real object photographed or rendered in a professional 3D studio

The result should retain the **spirit and visual identity of the original sketch**.

### FINAL GOAL

The viewer should be able to look at the final 3D image and immediately recognize:

**"That's the funny thing this person drew — but somehow it became real."**

CHALLENGE:
${challengeText}

SKETCH:
(the attached image)`;
}

// Single global Cooldown (AD-5): one fixed KV key, no per-session/per-IP
// keying, matching this single-client hobby app's scale. Every attempt
// (success or failure) resets this clock, so it also gates back-to-back
// legitimate use — 6 minutes (10/hour worst-case cap) made repeated kid
// drawing sessions hit the wait screen constantly, so this trades a higher
// worst-case-abuse ceiling (~40/hour) for the app actually feeling
// responsive during normal use. 90s is the PRD OQ3 60-120s suggestion.
const COOLDOWN_MS = 90000;
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
