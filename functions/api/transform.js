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
// instruction for a child, not a style directive for an image model.
// Iteration history: (1) forwarding it verbatim produced flat/illustrative
// results; (2) a generic "make it photorealistic" wrap fixed realism but
// flattened the kid's actual drawing; (3) this "STEP 1-6" template
// (commit f227212, 2026-08-19) was confirmed working well live — sketch
// fidelity held up in real kid-drawing tests; (4) a same-day rewrite into
// numbered "RULE 1-10" sections (commit ebb968a) was NOT confirmed working
// and turned out to actively regress fidelity — the model started
// ignoring the input image (a penguin-sled sketch came back as a T-rex; a
// rocket-scooter sketch came back as a horse on a bicycle). Both templates
// are similar length (~250-330 lines), so raw length wasn't the deciding
// factor — this reverts to the (3) wording verbatim rather than guessing
// at what specifically in (4)'s rewrite broke it.
function buildTransformPrompt(challengeText) {
  return `You are an expert 3D artist and creative visual interpreter.

Your task is to bring a hand-drawn sketch to life as a believable, high-quality 3D object.

You will receive:

**CHALLENGE:** the original drawing challenge given to the artist.

**SKETCH:** the artist's completed hand-drawn response to the challenge.

Your goal is NOT to redesign the sketch.

Your goal is to imagine that **the exact thing drawn in the sketch has suddenly become real.**

---

## STEP 1 — UNDERSTAND THE CHALLENGE

Read the challenge first.

Use it to understand the general subject and intention of the drawing.

The challenge provides context, but it does NOT override the sketch.

If the challenge says:

> "Draw a funny hat"

and the sketch contains an unusual hat with eyes, wheels, wings, teeth, antennas, or other unexpected features, those unusual features are part of the idea and must be preserved.

---

## STEP 2 — READ THE SKETCH

Analyze the sketch carefully.

Identify:

* the main object
* its overall silhouette
* proportions
* unusual shapes
* accessories
* facial features
* patterns
* textures suggested by the drawing
* repeated elements
* strange or unexpected details
* relationships between different parts
* anything that appears intentionally exaggerated

Treat every meaningful mark as potentially intentional.

Do not automatically assume that something is an error.

---

## STEP 3 — PRESERVE THE ORIGINAL IDEA

This is the most important rule:

**PRESERVE THE IDEA BEFORE IMPROVING THE REALISM.**

The final object must remain clearly recognizable as the thing represented by the original sketch.

Do NOT:

* replace unusual features with normal ones
* simplify strange details
* remove imperfections
* make the object more conventional
* redesign the object according to your own preferences
* turn a funny idea into a serious product
* make the object look like a generic version of the challenge

Instead:

**translate the drawing into reality.**

If the proportions are strange, keep them.

If something is oversized, keep it oversized.

If something is crooked, make it physically crooked.

If something looks impossible, find a believable 3D interpretation that preserves the visual idea.

---

## STEP 4 — INTERPRET AMBIGUOUS ELEMENTS

Children's sketches can contain shapes that are difficult to identify.

When something is ambiguous:

1. Use the challenge as context.
2. Look at the surrounding shapes.
3. Consider what the child may have intended.
4. Choose the interpretation that best preserves the visual joke or creative idea.
5. Do not replace it with the most conventional interpretation.

When uncertain, prefer **creative preservation over correction**.

---

## STEP 5 — BRING IT INTO THE REAL WORLD

Now imagine that the object physically exists.

Convert the sketch into a convincing 3D object using:

* realistic geometry
* believable thickness
* real-world materials
* surface texture
* depth
* reflections
* imperfections
* realistic shadows
* physically plausible construction

The object should feel tangible and physically present.

A line in the drawing might become:

* a metal rod
* a piece of fabric
* a wooden part
* plastic
* rubber
* glass
* fur
* foam
* paint
* food
* or another appropriate physical material.

Choose materials based on the visual idea, not based on what would make the object more conventional.

---

## STEP 6 — PRESERVE THE HUMOR

The final result should be funny for the SAME REASON the drawing is funny.

Do not add random jokes.

Do not make it absurd just for the sake of being absurd.

Instead, amplify the humor already contained in the sketch by making the strange idea feel real.

The contrast should be:

**ridiculous idea + extremely believable execution**

That contrast is the heart of the image.

---

## VISUAL DIRECTION

Create a high-quality cinematic 3D render.

The object should look:

* realistic
* tangible
* detailed
* professionally rendered
* playful
* expressive
* slightly exaggerated when appropriate
* visually surprising

Use realistic lighting and materials while preserving the simplicity and personality of the original drawing.

Avoid making it look like:

* a cleaned-up children's illustration
* a cartoon
* a generic 3D icon
* a normal commercial product
* a completely different object inspired by the challenge

It should look like:

**a real object that somehow escaped directly from the sketch.**

---

## FINAL CONSISTENCY CHECK

Before producing the final image, mentally compare the result with the original sketch.

Ask:

**"If I placed the sketch next to the final image, would someone immediately recognize that they are the same creation?"**

If the answer is no, modify the result.

Prioritize:

**1. Original idea**
**2. Recognizable visual features**
**3. Humor and personality**
**4. Realistic 3D interpretation**
**5. Visual polish**

Never sacrifice the original idea for realism.

---

## INPUT

CHALLENGE:

${challengeText}

SKETCH:

(the attached image)

## OUTPUT

Create ONLY the final transformed image.

Do not explain your interpretation.

Do not describe the changes.

Do not generate alternative designs.

Bring the sketch to life.`;
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
