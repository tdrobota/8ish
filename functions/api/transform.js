// Transform Proxy — Cloudflare Worker route for POST /api/transform
//
// Takes a locked sketch (raw base64 PNG, no "data:" prefix) plus a
// server-known promptId, runs it through the Workers AI image-edit model via
// the `env.AI` binding, and returns the rendered image as raw base64 PNG.
//
// Story 7.5 rewrite (AD-14/AD-22, epic-7-context.md): the old shared
// `x-app-token` + single-global-KV-cooldown contract is gone, replaced by
// the Spend Governor (Stories 7.2-7.4) and the `c1.` Entitlement Credential
// (Story 6.2) — subscribers only; free-device support is Story 7.6's job.
// New contract: `POST {sketch, promptId}` with `Authorization: Bearer
// <credential>`. Every request is validated (byte-capped body, base64/PNG
// structure, dimensions, known promptId) BEFORE the credential is even
// looked at, and the credential is verified BEFORE any Governor/AI call —
// so a malformed or unauthenticated request costs nothing (AD-23, "no state
// before proof"). `promptId` closes defect A-31: the client sends only an
// id, never prompt text — the English text that reaches the model always
// comes from this server's own public/prompts.js bank, never the request
// body.
//
// Story 7.6 adds a SECOND branch, selected purely by whether the
// `Authorization` header is present at all: present -> the subscriber path
// above, exactly as Story 7.5 built it, completely untouched by this
// addition; absent -> the new free-device path (a `d1.` device token in a
// separate `X-Device-Token` header, gated by a fresh Turnstile human check).
// No cookie, fingerprint, or IP address is ever read anywhere in either
// path (AD-16) — free-tier bot resistance is Turnstile alone, best effort
// by design. Both branches share the "reserve -> call the model -> settle"
// logic (`runModelAndSettle` below) once a Governor reservation is granted,
// so there is exactly one place that ever builds the multipart request or
// races the 30s timeout.
//
// This is the sole file in the repo that references `context.env.AI` — no
// provider API key or SDK is used anywhere; the binding is billed to the
// Cloudflare account directly (dashboard-configured, see architecture AD-9).
//
// Deployed with `AI_ENABLED:false` until Story 7.7 (epic-7-context.md's own
// release note) — this story builds the endpoint, it doesn't yet turn real
// traffic loose on it.
//
// Story 7.8 (spec-7-8-quota-defenses.md, AD-23): a purely ADDITIVE layer,
// lib/request-throttle.js's per-isolate pre-limit + deny cache, sits in
// front of EVERY real Governor `reserve()` call this file makes (the
// subscriber path's `sub`, and the free-device path's `free`/`mint`/`free`
// again after a mint) — a stateless per-key pre-limit denies a burst before
// the Governor is ever asked, and a REAL `wait`/`daily_limit` denial the
// Governor already returned once is remembered for 60s so a repeat for the
// same key doesn't cost a second Governor call. None of this changes this
// file's own validate -> credential/device-token -> Governor ordering or
// response mapping from Stories 7.5-7.7 — every check runs exactly where
// the real Governor call used to be the very next thing. `readCappedBody`
// also moved out to lib/http-body.js this story (byte-for-byte the same
// logic, now shared with every other POST endpoint in this app) — this file
// no longer keeps its own private copy.
//
// Story 8.5 (spec-8-5-governor-reports-state.md): the Governor reports its
// own state, entirely via ctx.waitUntil, never on the response's own
// critical path. Every REAL image-spend commit inside `runModelAndSettle`'s
// success branch (never the unrelated `mint` commit in the free-device
// path, which never calls `runModelAndSettle` at all) now also reports a
// `gov_gauge` data point and checks/records the 80%/100% ceiling crossings
// via `reportGovernorGauge` below. Both existing `resting` response sites
// (Kill Switch off, or an invalid/unreadable `cfg:governor`) now also fire a
// `killswitch_seen` alert. Zero new surface on `functions/governor.js` /
// `functions/lib/governor-do.js` / `functions/lib/governor-core.js` — this
// story reuses Story 8.4's existing `getDailyImageCounts(budgetDay)` RPC
// method as-is (see that story's own Design Notes for why this is enough).

import * as credential from "../lib/credential.js";
import * as deviceToken from "../lib/device-token.js";
import * as turnstile from "../lib/turnstile.js";
import { loadGovernorConfig } from "../lib/governor-config.js";
import { readCappedBody } from "../lib/http-body.js";
import { checkPreLimit, checkDenyCache, recordDenial, PRE_LIMIT_RETRY_AFTER } from "../lib/request-throttle.js";
import { writeEvent, writeGovGauge, notifyAlert } from "../lib/events.js";
import prompts from "../../public/prompts.js";

// Story 7.6: the action name Turnstile's widget is invoked with on the
// canvas screen for a free-device Image request (epic-7-context.md's own
// "UX & Interaction Patterns": "Every free Image request carries a fresh
// Turnstile token").
const HUMAN_CHECK_ACTION = "image";

const MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";
const TIMEOUT_MS = 30000;

// Actual bytes read, never a trusted Content-Length (Content-Length can be
// absent or wrong) — enforced by readCappedBody() below, which never
// consults the header at all.
const MAX_BODY_BYTES = 400 * 1024;

// The decoded PNG is capped separately and tighter than the request body as
// a whole (room for JSON structure/escaping around the base64 field).
// Checked twice: once cheaply on the base64 string's own length (before
// spending any time decoding it), once for real on the decoded byte count.
const MAX_DECODED_PNG_BYTES = 256 * 1024;
const MAX_SKETCH_B64_LEN = Math.ceil((MAX_DECODED_PNG_BYTES * 4) / 3);

// IHDR is always the first chunk in a valid PNG — not a heuristic.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52]; // ASCII "IHDR"
const MAX_PNG_DIMENSION = 512;

const BEARER_RE = /^Bearer\s+(\S+)$/i;

// Story 8.5: a local, private UTC-day-string helper -- replicates
// governor-core.js's own private `utcDateString()` (`Intl.DateTimeFormat
// ("en-CA", {timeZone:"UTC"})`, formatting a well-formed `YYYY-MM-DD` from a
// real calendar lookup, never naive offset arithmetic) rather than exporting
// anything new from that file, per this story's frozen "zero new
// Governor-DO surface" boundary. Same well-established technique
// functions/lib/rollup.js's own `yesterdayUtcDate()` already uses for the
// same reason.
const GOV_UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
function utcDateString(nowMs) {
  return GOV_UTC_DAY_FORMATTER.format(new Date(nowMs));
}

// Story 8.5: `state:<budgetDay>` KV's expiration -- comfortably longer than
// the single UTC budget day this key is ever actually read/written for, so
// it self-cleans without this file needing its own sweep/prune job.
const GOV_STATE_TTL_SECONDS = 3 * 24 * 60 * 60;

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

// Headers.get() is already case-insensitive by spec, so one lookup covers
// "authorization", "Authorization", or any other casing a caller sends —
// mirrors entitlement.js's exact extraction pattern.
function extractBearerToken(request) {
  const header = request.headers.get("authorization");
  if (typeof header !== "string") return null;
  const match = BEARER_RE.exec(header.trim());
  return match ? match[1] : null;
}

// Story 7.6: a separate header from `Authorization` (see the file header
// comment for why) — a distinct header, never a second use of the same one,
// is what keeps the two token types structurally unable to be confused for
// one another at the point a request arrives. Headers.get() is already
// case-insensitive, same reasoning as extractBearerToken() above. Returns
// null for a missing header (never an empty string), which is exactly what
// "no token at all" needs to look like to device-token.verify() below.
function extractDeviceToken(request) {
  const header = request.headers.get("x-device-token");
  return typeof header === "string" && header ? header : null;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

// PNG signature (8 bytes) + the IHDR chunk (always the first chunk in a
// valid PNG — not a heuristic): a 4-byte length (must be 13), the 4-byte
// ASCII type "IHDR", then width/height as big-endian uint32s, each read
// directly from the bytes and both capped at MAX_PNG_DIMENSION. Any
// structural mismatch anywhere is a rejection — never an Image/canvas API,
// which doesn't exist in the Workers runtime anyway.
function isValidPng(bytes) {
  if (bytes.length < 24) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  if (readUint32BE(bytes, 8) !== 13) return false;
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (bytes[12 + i] !== IHDR_TYPE[i]) return false;
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  // Story 7-5 review finding (found independently by two lenses): a
  // zero-width or zero-height IHDR passed the upper-bound-only check below,
  // letting a trivially hand-crafted 24-byte buffer (real signature + IHDR
  // claiming 0x0) reach a real Governor reservation and a real, billed
  // env.AI.run() call before failing at the model layer -- real spend
  // consequences for a payload that was never going to produce an image.
  // Both dimensions must be strictly positive, not just within the upper
  // bound.
  return width > 0 && width <= MAX_PNG_DIMENSION && height > 0 && height <= MAX_PNG_DIMENSION;
}

// Reads public/prompts.js's EN array (the server's own prompt bank, id ->
// English text) and looks up the given id — an unknown id returns null.
// This is the only place prompt TEXT is ever produced for the model; the
// request body's `promptId` is the only prompt-related field ever read.
function findPromptById(promptId) {
  const list = prompts && Array.isArray(prompts.EN) ? prompts.EN : [];
  return list.find((entry) => entry && entry.id === promptId) || null;
}

// A denied reserve() maps directly to its matching HTTP response.
// `retryAfterSeconds` is included only when the Governor's own denial
// actually supplied one — `wait` does (governor-core.js's checkMinGap),
// `daily_limit`/`rate_limited` never do (checked directly against
// governor-core.js's own return shapes, not assumed/invented here). Any
// other denial reason (including "resting" itself, or an unrecognized one)
// fails closed the same way governor-core.js's own unrecognized-kind branch
// does: 503 resting.
//
// Story 7.6 split this into `denialBody` (the pure {status, body} shape) and
// `denialResponse` (its Response wrapper, unchanged from Story 7.5's own
// behavior/call sites) purely so the free-device mint-then-reserve edge case
// below can build the SAME body/status this function would produce, then add
// a `device` field on top — without duplicating the mapping logic itself.
function denialBody(reservation) {
  const denied = reservation && reservation.denied;
  if (denied === "wait" || denied === "daily_limit" || denied === "rate_limited") {
    const body = { error: { code: denied } };
    if (typeof reservation.retryAfterSeconds === "number") {
      body.error.retryAfterSeconds = reservation.retryAfterSeconds;
    }
    return { status: 429, body };
  }
  return { status: 503, body: { error: { code: "resting" } } };
}

function denialResponse(reservation) {
  const { status, body } = denialBody(reservation);
  return jsonResponse(status, body);
}

export async function onRequestPost(context) {
  const { request, env, ctx } = context;

  // 1. Actual byte-count cap, read from the real bytes -- zero
  // credential/Governor/AI calls before this passes.
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 2. Parse the capped body as JSON.
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 3. Required-field shape check -- the OLD shape (image/prompt/
  // x-app-token) simply doesn't satisfy this; no special-cased detection.
  if (!body || typeof body !== "object" || typeof body.sketch !== "string" || !body.sketch || typeof body.promptId !== "string" || !body.promptId) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 4. Base64 -> bytes, capped both before (cheap, on the string's own
  // length) and after decoding (the real byte count).
  if (body.sketch.length > MAX_SKETCH_B64_LEN) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }
  let pngBytes;
  try {
    pngBytes = base64ToBytes(body.sketch);
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }
  if (pngBytes.length > MAX_DECODED_PNG_BYTES) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 5. Real PNG structure/dimension validation.
  if (!isValidPng(pngBytes)) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 6. promptId -> server-known English text (closes defect A-31: client
  // prompt TEXT is never read from the request body at all).
  const promptEntry = findPromptById(body.promptId);
  if (!promptEntry) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // 7. Branch purely on whether Authorization is present AT ALL (Story
  // 7.6's Design Notes: "an Authorization header present routes to Story
  // 7.5's branch unconditionally; its absence routes here") -- never on
  // whether it parses as a valid Bearer token, so a present-but-garbage
  // header still reaches the EXACT SAME 401 unauthorized outcome Story 7.5
  // already produces, completely untouched by this branch's existence.
  const hasAuthorizationHeader = request.headers.get("authorization") !== null;
  if (hasAuthorizationHeader) {
    return handleSubscriberRequest({ request, env, ctx, pngBytes, promptEntry });
  }
  return handleFreeDeviceRequest({ body, request, env, ctx, pngBytes, promptEntry });
}

// --- Story 7.5: the subscriber path (Authorization present) ---------------
//
// Byte-for-byte Story 7.5's own onRequestPost steps 7-9, unmodified in their
// own logic -- only lifted into its own function so Story 7.6's free-device
// branch can live alongside it without the two being interleaved in one
// function body. Steps 10-12 (build the multipart request, invoke the
// model, race the timeout, settle) now live in the shared
// `runModelAndSettle` below, called identically to how this function's own
// inline code used to run them.
async function handleSubscriberRequest({ request, env, ctx, pngBytes, promptEntry }) {
  // 7. ONLY NOW: credential verification (mirrors entitlement.js's own
  // extraction/verification pattern exactly). Zero KV/Governor/AI calls
  // before this passes.
  const token = extractBearerToken(request);
  let credPayload;
  try {
    credPayload = await credential.verify(env, token);
  } catch (error) {
    if (error instanceof credential.NotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    throw error;
  }
  if (!credPayload) {
    return jsonResponse(401, { error: { code: "unauthorized" } });
  }

  // 8. ONLY NOW: the Governor config / Kill Switch. Zero reserve() calls if
  // this fails (covers AI_ENABLED disabled AND an invalid/unreadable
  // cfg:governor).
  const configResult = await loadGovernorConfig(env);
  if (!configResult.ok) {
    // Story 8.5: killswitch_seen -- fires for BOTH underlying reasons this
    // answers resting alike (AI_ENABLED off, or an invalid/unreadable
    // cfg:governor -- see the frozen Design Notes' "same observable
    // response" reasoning). Called bare, NOT wrapped in ctx.waitUntil --
    // notifyAlert (like writeEvent, which it delegates to) already calls
    // ctx.waitUntil internally on the caller's behalf and itself returns
    // undefined; wrapping it here would pass ctx.waitUntil(undefined),
    // which real Cloudflare Workers' ExecutionContext.waitUntil (bound to
    // a native kj::Promise<void> parameter) throws a synchronous TypeError
    // on -- turning this deliberately fail-closed 503 into an unhandled
    // worker exception instead (a review finding, fixed here). Matches
    // every other writeEvent(...)-family call site in this file (e.g.
    // image_refused/image_failed/image_created), all of which are called
    // bare for the same reason.
    notifyAlert(env, ctx, "killswitch_seen");
    return jsonResponse(503, { error: { code: "resting" } });
  }

  // 9. Story 7-8: a cheap, additive layer in front of the real Governor
  // call -- a stateless per-key pre-limit, then a per-isolate deny cache for
  // a REAL wait/daily_limit denial the Governor already returned once (see
  // lib/request-throttle.js's own header). Neither changes this function's
  // own validate -> credential -> Governor ordering; both only ever run
  // AFTER the credential has already verified, exactly where the real
  // Governor call used to be the very next thing.
  const subKey = credPayload.sub;
  if (!checkPreLimit(subKey)) {
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse({ denied: "wait", retryAfterSeconds: PRE_LIMIT_RETRY_AFTER });
  }
  const subCachedDenial = checkDenyCache(subKey);
  if (subCachedDenial) {
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse({ denied: subCachedDenial.code, retryAfterSeconds: subCachedDenial.retryAfterSeconds });
  }

  // 10. Reserve against the single shared Governor instance (AD-14), called
  // as an RPC method on the stub -- never a fetch().
  const governorStub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
  const reservation = await governorStub.reserve("sub", subKey, configResult.cfg);
  if (!reservation.ok) {
    if (reservation.denied === "wait" || reservation.denied === "daily_limit") {
      recordDenial(subKey, { code: reservation.denied, retryAfterSeconds: reservation.retryAfterSeconds });
    }
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse(reservation);
  }

  // 10-12: build the multipart request, invoke the model, race the 30s
  // timeout, and settle -- see runModelAndSettle's own comment.
  return runModelAndSettle({ env, ctx, governorStub, reservationId: reservation.id, pngBytes, promptEntry, cfg: configResult.cfg });
}

// --- Story 7.6: the free-device path (Authorization absent) ---------------
//
// No cookie, fingerprint, or IP-derived value is ever read anywhere in this
// function (AD-16) -- the only identity this path ever consults is the
// `X-Device-Token` header (extractDeviceToken) and the Turnstile token in
// the request body, both under the caller's own control, neither traceable
// back to a specific child across sessions the way a cookie or IP would be.
async function handleFreeDeviceRequest({ body, request, env, ctx, pngBytes, promptEntry }) {
  // a. Turnstile human check FIRST -- zero Governor/KV calls on either
  // failure branch (the frozen spec's own "Always": "a failed check costs
  // nothing", AD-23).
  const turnstileToken = typeof body.turnstile === "string" ? body.turnstile : "";
  const turnstileResult = await turnstile.verifyDetailed(env, turnstileToken, HUMAN_CHECK_ACTION);
  if (!turnstileResult.ok) {
    // `not_configured`/`unreachable`: the service itself isn't answering,
    // not a judgment on the caller -- 503 resting (distinct from the 403
    // below). `invalid`: a genuine missing/wrong-action/wrong-hostname/
    // replayed token, or a missing token/action from the caller -- 403
    // human_check_failed. See turnstile.js's own verifyDetailed() comment
    // for the exact reason mapping.
    if (turnstileResult.reason === "invalid") {
      return jsonResponse(403, { error: { code: "human_check_failed" } });
    }
    return jsonResponse(503, { error: { code: "resting" } });
  }

  // b. The device token, if any -- read from its OWN header, never
  // Authorization (this branch is only ever reached when Authorization is
  // absent in the first place). A missing header, a forged `d1.` token, a
  // `c1.` credential handed in here, or a tampered signature all verify to
  // `null` alike -- device-token.verify() never distinguishes those cases
  // from one another, by design (the frozen spec: "treated identically to
  // 'no token at all' -- never as a partial/implicit pass").
  const deviceTokenHeader = extractDeviceToken(request);
  let devicePayload;
  try {
    devicePayload = await deviceToken.verify(env, deviceTokenHeader);
  } catch (error) {
    if (error instanceof deviceToken.NotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    throw error;
  }

  // c. ONLY NOW: the Governor config / Kill Switch -- same gate, same
  // ordering, same fail-closed behavior as the subscriber path's own step 8
  // (AI_ENABLED disabled or an invalid/unreadable cfg:governor both answer
  // resting with zero reserve() calls).
  const configResult = await loadGovernorConfig(env);
  if (!configResult.ok) {
    // Story 8.5: same killswitch_seen alert as the subscriber path's own
    // step 8 above, same reasoning -- called bare, not wrapped in
    // ctx.waitUntil (see that site's own comment for why).
    notifyAlert(env, ctx, "killswitch_seen");
    return jsonResponse(503, { error: { code: "resting" } });
  }
  const cfg = configResult.cfg;
  const governorStub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));

  if (devicePayload) {
    // Story 7-8: same additive pre-limit/deny-cache layer as the subscriber
    // path's own step 9 above, keyed by this device's own id.
    const freeKey = devicePayload.id;
    if (!checkPreLimit(freeKey)) {
      writeEvent(env, ctx, "image_refused", "");
      return denialResponse({ denied: "wait", retryAfterSeconds: PRE_LIMIT_RETRY_AFTER });
    }
    const freeCachedDenial = checkDenyCache(freeKey);
    if (freeCachedDenial) {
      writeEvent(env, ctx, "image_refused", "");
      return denialResponse({ denied: freeCachedDenial.code, retryAfterSeconds: freeCachedDenial.retryAfterSeconds });
    }

    // A valid, existing device token: reserve "free" directly against its
    // own allowance -- no mint involved at all.
    const reservation = await governorStub.reserve("free", freeKey, cfg);
    if (!reservation.ok) {
      if (reservation.denied === "wait" || reservation.denied === "daily_limit") {
        recordDenial(freeKey, { code: reservation.denied, retryAfterSeconds: reservation.retryAfterSeconds });
      }
      writeEvent(env, ctx, "image_refused", "");
      return denialResponse(reservation);
    }
    return runModelAndSettle({
      env,
      ctx,
      governorStub,
      reservationId: reservation.id,
      pngBytes,
      promptEntry,
      extraSuccessFields: { device: deviceTokenHeader },
      cfg,
    });
  }

  // No valid device token at all -- mint one, itself gated by the
  // Governor's own `mint` kind (mintPerHour). Per the frozen Design Notes:
  // reserve("mint", ...) first; a denial (the only one `mint` ever produces
  // is `rate_limited`) means 429 with no image and no token minted at all --
  // denialResponse() already maps that correctly (governor-core.js's `mint`
  // reservations all share one forced literal key regardless of what's
  // passed here, so the literal "mint" argument below is just documentation
  // for a human reader, not something the Governor actually keys on).
  // Story 7-8: same additive pre-limit/deny-cache layer, keyed by the
  // single fixed literal "mint" key every `mint` reservation shares
  // (governor-core.js's own convention -- see the comment on the real
  // reserve() call just below).
  const MINT_KEY = "mint";
  if (!checkPreLimit(MINT_KEY)) {
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse({ denied: "wait", retryAfterSeconds: PRE_LIMIT_RETRY_AFTER });
  }
  const mintCachedDenial = checkDenyCache(MINT_KEY);
  if (mintCachedDenial) {
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse({ denied: mintCachedDenial.code, retryAfterSeconds: mintCachedDenial.retryAfterSeconds });
  }

  const mintReservation = await governorStub.reserve("mint", "mint", cfg);
  if (!mintReservation.ok) {
    if (mintReservation.denied === "wait" || mintReservation.denied === "daily_limit") {
      recordDenial(MINT_KEY, { code: mintReservation.denied, retryAfterSeconds: mintReservation.retryAfterSeconds });
    }
    writeEvent(env, ctx, "image_refused", "");
    return denialResponse(mintReservation);
  }

  // `mint` reservations settle immediately (AD-14) -- awaited directly here
  // (NOT deferred via ctx.waitUntil()), because the free-image reservation
  // just below depends on this commit having genuinely already happened,
  // unlike the response-terminal settlement runModelAndSettle() defers
  // until after the response body is already fully known.
  await governorStub.commit(mintReservation.id);

  // Story 7-6 review finding (Blind Hunter): once the mint reservation above
  // is committed, it is PERMANENT -- governor-core.js's release() is a no-op
  // on an already-committed row, so there is no way to "give back" this
  // mintPerHour slot. Everything from here to the response must therefore
  // degrade to the app's own documented {error:{code}} envelope on ANY
  // throw, never let one escape uncaught -- an uncaught exception here would
  // both break every other branch in this file's "always a documented
  // envelope" invariant AND leave this mint slot permanently spent for
  // nothing. Wrapping the whole sequence (not just deviceToken.mint's own
  // NotConfiguredError, and not leaving the self-verify/reserve("free",...)
  // calls unguarded like the pre-review version did) closes that gap.
  let newDeviceToken;
  let newDevicePayload;
  let freeReservation;
  try {
    newDeviceToken = await deviceToken.mint(env);

    // The freshly-minted token's own id is needed as the Governor key for
    // the "free" reserve just below; device-token.js exposes no separate
    // id-extraction accessor (only mint()/verify()), so the cleanest way to
    // get it without duplicating this file's own knowledge of the `d1.`
    // format is to verify the token mint() just produced -- a token mint()
    // just minted always verifies (same secret, same process), so a null
    // result here would mean a genuine internal inconsistency, not a caller
    // error.
    newDevicePayload = await deviceToken.verify(env, newDeviceToken);
    if (!newDevicePayload) {
      console.error("transform_device_mint_verify_mismatch");
      return jsonResponse(500, { error: { code: "not_configured" } });
    }

    // Story 7-8 (judgment call -- see this story's Spec Change Log): the
    // same additive pre-limit/deny-cache layer as every other reserve()
    // call site in this file, applied here too even though a freshly-minted
    // device id will almost never already be pre-limited or deny-cached --
    // covers the case of a caller re-verifying the SAME freshly-minted
    // token in quick succession. Per the Design Notes' own resolved answer
    // for the surrounding edge case, the mint already happened and is real,
    // so a denial here still carries the `device` field, exactly like the
    // real freeReservation-denied-after-mint case just below.
    const newDeviceKey = newDevicePayload.id;
    if (!checkPreLimit(newDeviceKey)) {
      writeEvent(env, ctx, "image_refused", "");
      const { status, body: deniedBody } = denialBody({ denied: "wait", retryAfterSeconds: PRE_LIMIT_RETRY_AFTER });
      return jsonResponse(status, { ...deniedBody, device: newDeviceToken });
    }
    const newDeviceCachedDenial = checkDenyCache(newDeviceKey);
    if (newDeviceCachedDenial) {
      writeEvent(env, ctx, "image_refused", "");
      const { status, body: deniedBody } = denialBody({ denied: newDeviceCachedDenial.code, retryAfterSeconds: newDeviceCachedDenial.retryAfterSeconds });
      return jsonResponse(status, { ...deniedBody, device: newDeviceToken });
    }

    freeReservation = await governorStub.reserve("free", newDeviceKey, cfg);
  } catch (error) {
    if (error instanceof deviceToken.NotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    console.error("transform_device_mint_sequence_failed");
    return jsonResponse(502, { error: { code: "provider_error" } });
  }

  if (!freeReservation.ok) {
    // Design Notes' resolved answer for this edge case: the mint already
    // happened and is real -- withholding the token would force a
    // legitimately-minted device to burn another mintPerHour slot on its
    // very next retry for no reason. The response still carries the
    // newly-minted `device` token alongside the matching denial.
    if (freeReservation.denied === "wait" || freeReservation.denied === "daily_limit") {
      recordDenial(newDevicePayload.id, { code: freeReservation.denied, retryAfterSeconds: freeReservation.retryAfterSeconds });
    }
    writeEvent(env, ctx, "image_refused", "");
    const { status, body: deniedBody } = denialBody(freeReservation);
    return jsonResponse(status, { ...deniedBody, device: newDeviceToken });
  }

  return runModelAndSettle({
    env,
    ctx,
    governorStub,
    reservationId: freeReservation.id,
    pngBytes,
    promptEntry,
    extraSuccessFields: { device: newDeviceToken },
    cfg,
  });
}

// --- shared by both paths: a reservation is already granted, now spend it -
//
// Byte-for-byte Story 7.5's own steps 10-12, unmodified in their own logic
// -- only lifted into a function so Story 7.6's free-device path can call
// the EXACT same model-invocation/timeout-race/settle logic instead of a
// second copy of it. `extraSuccessFields` is merged into the 200 body only
// -- `{}` (the default) for the subscriber path, producing the unchanged
// `{image}` shape; `{device}` for the free-device path, producing this
// story's own `{image, device}` shape. Every failure response shape below
// is completely unaffected by this parameter.
//
// Story 8.5 adds exactly one new parameter (`cfg` -- both callers already
// have it in scope: the subscriber path's `configResult.cfg`, the free
// path's own `cfg`) and one new `ctx.waitUntil(...)` call at the very end of
// the success branch below, after the existing commit/writeEvent("image_created")
// -- steps 10-12's own model-call/timeout-race/failure-handling logic is
// otherwise untouched.
async function runModelAndSettle({ env, ctx, governorStub, reservationId, pngBytes, promptEntry, extraSuccessFields = {}, cfg }) {
  // 10. Build the multipart request (unchanged shape from the pre-7.5
  // file -- only the prompt TEXT source changed, via promptEntry.text
  // above) and invoke the model through the env.AI_STUB test seam when
  // present. A synchronous failure here -- the request never actually
  // reaching the model -- releases `neverCalled`, distinct from the model
  // call itself failing below.
  let runPromise;
  try {
    const imageBlob = new Blob([pngBytes], { type: "image/png" });
    const form = new FormData();
    form.append("prompt", buildTransformPrompt(promptEntry.text));
    form.append("input_image_0", imageBlob);

    // Cloudflare's documented trick for turning a FormData into the raw
    // multipart body + content-type this model family's binding expects.
    const formResponse = new Response(form);
    const runArgs = {
      multipart: {
        body: formResponse.body,
        contentType: formResponse.headers.get("content-type"),
      },
    };

    // env.AI_STUB: a test-only seam with the same call shape as
    // env.AI.run(modelId, args) -- production env never sets this, so real
    // deploys always use the real binding.
    runPromise = typeof env.AI_STUB === "function" ? env.AI_STUB(MODEL_ID, runArgs) : env.AI.run(MODEL_ID, runArgs);
  } catch {
    ctx.waitUntil(governorStub.release(reservationId, { neverCalled: true }));
    writeEvent(env, ctx, "image_failed", "");
    console.error("transform_prebuild_failed");
    return jsonResponse(502, { error: { code: "provider_error" } });
  }

  // 11. Race the actual model call against the fixed timeout.
  let result;
  try {
    result = await raceWithTimeout(runPromise, TIMEOUT_MS);
  } catch (error) {
    ctx.waitUntil(governorStub.release(reservationId, { providerFailed: true }));
    writeEvent(env, ctx, "image_failed", "");
    if (error instanceof TimeoutError) {
      console.error("transform_timeout");
      return jsonResponse(504, { error: { code: "timeout" } });
    }
    console.error("transform_provider_error");
    return jsonResponse(502, { error: { code: "provider_error" } });
  }

  // A malformed/empty success is treated the same as a provider failure.
  if (typeof result?.image !== "string" || result.image.length === 0) {
    ctx.waitUntil(governorStub.release(reservationId, { providerFailed: true }));
    writeEvent(env, ctx, "image_failed", "");
    console.error("transform_provider_malformed");
    return jsonResponse(502, { error: { code: "provider_error" } });
  }

  // 12. Success: commit via waitUntil (never awaited inline -- the response
  // body is already fully known by this point) and return the image.
  ctx.waitUntil(governorStub.commit(reservationId));
  writeEvent(env, ctx, "image_created", "");
  // Story 8.5: the Governor reports its own state on this REAL image-spend
  // commit only (never the free-device path's separate `mint` commit, which
  // never reaches this function at all). Entirely fire-and-forget, entirely
  // after the response below is already being returned.
  ctx.waitUntil(reportGovernorGauge(env, ctx, governorStub, cfg));
  return jsonResponse(200, { image: stripDataUriPrefix(result.image), ...extraSuccessFields });
}

// Story 8.5 (spec-8-5-governor-reports-state.md): reports one `gov_gauge`
// data point for today's UTC budget day, then checks whether THIS commit is
// the first this budget day to cross 80%/100% of `cfg.ceiling`, recording
// each crossing at most once per day in `state:<budgetDay>` KV and firing
// the matching `notifyAlert` when it is. Zero new Governor-DO surface --
// `getDailyImageCounts(budgetDay)` is Story 8.4's existing, unchanged RPC
// method; `cfg.ceiling` is already loaded by both of this file's own
// callers before they ever reach the Governor (frozen Design Notes).
//
// Never throws, never awaited by its own caller (handed straight to
// ctx.waitUntil above) -- every await in this function is individually
// guarded so a Governor RPC failure, a KV outage, or any other unexpected
// error degrades to a logged-and-swallowed no-op rather than an unhandled
// rejection (frozen I/O matrix's own "logged and swallowed" row). A local
// UTC-day-string helper is used below (`utcDateString`) rather than
// exporting governor-core.js's own private equivalent -- see that
// function's own comment for why.
async function reportGovernorGauge(env, ctx, governorStub, cfg) {
  try {
    const budgetDay = utcDateString(Date.now());

    let counts;
    try {
      counts = await governorStub.getDailyImageCounts(budgetDay);
    } catch (error) {
      console.error("gov_gauge_rpc_failed");
      return;
    }

    const free = counts && typeof counts.free === "number" ? counts.free : 0;
    const sub = counts && typeof counts.sub === "number" ? counts.sub : 0;
    const total = counts && typeof counts.imagesTotal === "number" ? counts.imagesTotal : free + sub;
    const ceiling = cfg && typeof cfg.ceiling === "number" ? cfg.ceiling : NaN;

    writeGovGauge(env, ctx, { total, free, sub, ceiling });

    // A missing/invalid/zero ceiling can't produce a meaningful ratio --
    // skip the crossing check entirely rather than divide by zero or a
    // non-finite value (in practice unreachable here: a real commit only
    // ever happens after `reserve()` already succeeded against this same
    // `cfg`, and governor-core.js's own checkCeiling fails closed on
    // exactly this condition -- this guard is defense-in-depth, not a real
    // observed path).
    if (!Number.isFinite(ceiling) || ceiling <= 0) return;

    const ratio = total / ceiling;
    // No KV read AND no KV write at all below 80% (frozen "Always": "No KV
    // write happens below the 80% threshold") -- there is nothing to check
    // or record yet.
    if (ratio < 0.8) return;

    const stateKey = `state:${budgetDay}`;
    let state = {};
    try {
      const raw = await env.STATE_KV.get(stateKey, { type: "json" });
      if (raw && typeof raw === "object") state = raw;
    } catch (error) {
      console.error("gov_gauge_state_read_failed");
    }

    // Both crossings are checked against the SAME `ratio`, so a commit that
    // jumps straight past both thresholds in one step (e.g. a low freeDaily/
    // ceiling in a test/dev config) fires both alerts on that same commit,
    // per the frozen I/O matrix's own explicit edge case.
    const needsCeiling80 = ratio >= 0.8 && !state.ceiling80;
    const needsCeilingReached = ratio >= 1.0 && !state.ceilingReached;
    if (!needsCeiling80 && !needsCeilingReached) return;

    const newState = { ...state };
    if (needsCeiling80) newState.ceiling80 = true;
    if (needsCeilingReached) newState.ceilingReached = true;

    try {
      // A few days' worth of TTL headroom past the one budget day this key
      // is ever actually consulted for -- comfortably outlives same-day
      // reads without accumulating KV keys forever (judgment call, see this
      // story's Spec Change Log).
      await env.STATE_KV.put(stateKey, JSON.stringify(newState), { expirationTtl: GOV_STATE_TTL_SECONDS });
    } catch (error) {
      console.error("gov_gauge_state_write_failed");
    }

    if (needsCeiling80) notifyAlert(env, ctx, "ceiling_80");
    if (needsCeilingReached) notifyAlert(env, ctx, "ceiling_reached");
  } catch (error) {
    console.error("gov_gauge_report_failed");
  }
}
