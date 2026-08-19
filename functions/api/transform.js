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
// flattened the kid's actual drawing (the model substituted its own
// generic interpretation of the challenge instead of preserving the
// sketch); (3) this template — the current one — makes the sketch the
// primary source and the challenge only context, explicitly tells the
// model to preserve rather than correct the sketch's own choices, and
// targets a 3D-render look rather than a flat photo.
function buildTransformPrompt(challengeText) {
  return `You are a professional creature designer and photorealistic 3D artist.

Your task is to take a child's hand-drawn sketch and make it look REAL.

The result must look as though the exact creature, object, or invention from the child's drawing has been brought into the real world and photographed.

This is NOT an illustration-to-illustration transformation.

This is a:

**CHILD'S DRAWING → REAL-WORLD CREATION**

transformation.

---

### INPUT

You will receive:

**CHALLENGE:**
The original challenge given to the child.

**SKETCH:**
The child's completed drawing.

The challenge tells you WHAT the child was asked to draw.

The sketch tells you WHAT the child actually imagined.

The sketch is the final authority.

---

# 1. COPY THE IDEA, NOT THE DRAWING STYLE

Do not make the final result look like a drawing.

Instead, convert the drawing into a believable physical 3D creation.

Turn:

* lines into physical structures
* circles into real forms
* flat shapes into volumes
* simple markings into real textures or coloration
* cartoon eyes into believable eyes
* simple legs into actual legs
* simple tails into physical tails
* strange shapes into believable anatomy or construction

The final result should have real:

* volume
* depth
* materials
* texture
* lighting
* shadows
* reflections
* surface imperfections

But the underlying design must remain the child's design.

---

# 2. PRESERVE THE CHILD'S DESIGN EXACTLY

This is the MOST IMPORTANT instruction.

Do not redesign the creature or object.

Do not make it more normal.

Do not make it more anatomically correct than necessary.

Do not replace strange features with conventional ones.

Preserve the child's:

* silhouette
* proportions
* number of limbs
* position of limbs
* size of body parts
* shape of head
* shape of eyes
* ears
* nose
* mouth
* tail
* markings
* spots
* patterns
* accessories
* unusual features
* exaggerated features
* asymmetry
* funny details

If the child drew something strange, **the strange thing is the point.**

---

# 3. DO NOT IDENTIFY THE CREATURE TOO EARLY

This is extremely important.

Do NOT think:

"This looks like a turtle, so I should make a realistic turtle."

Do NOT think:

"This looks like a dog, so I should make a normal dog."

Instead think:

**"What creature did THIS CHILD invent?"**

Use familiar animals or objects only as inspiration for realistic anatomy, materials and textures.

The final creature may resemble a dog, turtle, cow, dinosaur, insect, etc., but it must remain a **unique interpretation of the child's drawing**.

The child's unusual combination of features must remain visible.

---

# 4. PRESERVE PROPORTIONS

The proportions in the sketch are intentional unless clearly accidental.

If the child draws:

* an enormous head → keep it enormous
* tiny eyes → keep them tiny
* extremely long legs → keep them extremely long
* a huge body → keep it huge
* a tiny tail → keep it tiny
* an unusually long neck → keep it long
* oversized ears → keep them oversized

Do NOT normalize the proportions.

The final image should make the viewer think:

**"Wow. That's exactly what the child drew."**

---

# 5. PRESERVE THE FUNNY DETAILS

The humor comes from the child's imagination.

Do not add unrelated jokes.

Do not remove the strange details.

If the sketch has an unusual feature that makes it funny, make that feature look REAL.

For example:

A child's drawing of an animal with absurdly long legs should become an animal with absurdly long but physically believable legs.

A creature with a strange combination of animal features should become a believable creature with that exact combination.

The humor should come from:

**a ridiculous design presented with serious realism.**

---

# 6. REALISTIC INTERPRETATION OF IMPOSSIBLE FEATURES

Some parts of a child's drawing may not make physical sense.

Do not delete them.

Instead, creatively translate them into the real world.

Ask:

**"If this feature really existed, what would it physically look like?"**

For example:

A simple line → tail, antenna, horn, cable, branch, etc.

A circle → eye, wheel, opening, button, ornament, etc.

A scribbled patch → fur, scales, feathers, paint, spots, texture, etc.

A strange geometric shape → physical object or anatomical structure.

The interpretation should preserve the VISUAL IDEA of the child's mark.

---

# 7. REALISM LEVEL

The final result should be highly realistic.

Imagine:

**photorealistic creature + cinematic photography + believable 3D materials**

Use:

* realistic skin/fur/scales/materials
* realistic eyes
* natural surface imperfections
* believable anatomy
* physically plausible lighting
* realistic shadows
* environmental interaction
* convincing depth
* detailed textures

The creature should look like it could actually exist.

However:

**REALISM applies to the execution, NOT to the design.**

This distinction is critical.

The design can be completely ridiculous.

The rendering should be completely believable.

---

# 8. KEEP THE ORIGINAL VISUAL PERSONALITY

Do not make every result look like a generic Hollywood creature.

The final creature should retain the personality of the child's drawing.

If the drawing is:

* cute → make it genuinely cute
* silly → make it silly
* weird → make it weird
* awkward → preserve the awkwardness
* adorable → preserve the innocence
* bizarre → embrace the bizarre design

The child should be able to recognize their own drawing immediately.

---

# 9. COMPOSITION

Present the final creation as a real-world subject.

Use a believable environment appropriate to the subject.

For example:

* animal → natural environment, park, garden, street, house, etc.
* vehicle → road or appropriate setting
* food → realistic table/kitchen environment
* machine → realistic physical environment
* imaginary object → environment that makes sense for the object

The environment should support the illusion that the creation actually exists.

Do not let the environment distract from the creation.

The creature/object is the HERO of the image.

---

# 10. THE "SIDE-BY-SIDE TEST"

Before finalizing the image, compare the generated creation mentally with the original sketch.

Ask:

**Could the child look at this image and immediately say: "That's what I drew!"?**

Check:

* silhouette
* proportions
* major shapes
* number of parts
* unusual characteristics
* markings
* facial features
* overall personality

If the answer is no, prioritize fidelity to the sketch over realism.

---

# CORE PRINCIPLE

Remember this sentence throughout the entire transformation:

**DO NOT MAKE THE DRAWING BETTER. MAKE THE DRAWING REAL.**

The child's drawing is not a rough draft that needs to be corrected.

It is the DESIGN.

Your job is to build the real-world version of that design.

---

### CHALLENGE

${challengeText}

### CHILD'S SKETCH

(the attached image)

### FINAL OUTPUT

Generate ONE highly realistic, funny, visually compelling 3D representation of the exact creation in the child's sketch.

No explanation.

No alternative versions.

No redesign.

No simplification.

**Make the child's imagination real.**`;
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
