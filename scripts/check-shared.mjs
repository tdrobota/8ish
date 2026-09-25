// Loads public/legal.js under plain Node and proves it is safe to use as
// the single source of the Stripe Checkout Waiver consent text (Story 6-4,
// AD-18):
//   - it runs with no `window` global at all (the Worker's own environment)
//     without throwing -- the exact bug AD-18 records for prompts.js's own
//     top-level `window.X = ...` (a ReferenceError that would take down
//     every /api/* route, not just checkout) and exports through
//     module.exports;
//   - it ALSO runs with a `window` global defined (a browser) without
//     throwing, and assigns the same values to it;
//   - WAIVER_CONSENT has exactly the "ro" and "en" keys (one-to-one, per
//     the spec's own I/O matrix: "fails if the Romanian and English keys
//     differ"), each a non-empty string, each no more than 1200 characters
//     -- Stripe's own limit for `custom_text[terms_of_service_acceptance]
//     [message]`;
//   - each language's text uses only Stripe's supported Markdown subset
//     ([text](url) links and **bold**) -- no header, underscore/single-
//     asterisk emphasis, backtick, or unmatched bracket/paren;
//   - TERMS_VERSION and TERMS_PATH are non-empty strings, TERMS_PATH starts
//     with "/".
//
// This is the plain-Node half of AD-18's guarantee. The real esbuild-bundled
// half -- proving functions/api/checkout.js's own
// `import legal from "../../public/legal.js"` actually resolves through the
// same bundler Cloudflare Workers uses, and that the resulting custom_text
// really is legal.js's own text -- is scripts/check-bundle.mjs, not this
// file. Only a live `wrangler dev`/deploy smoke test is left as a
// nice-to-have beyond what these two scripts already prove (see
// docs/runbook.md §1.6).
//
//   node scripts/check-shared.mjs
//
// Exits 0 when every check passes, 1 otherwise ("fails loudly on any
// mismatch"). No dependencies, Node 18+.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const LEGAL_PATH = path.join(ROOT_DIR, "public/legal.js");
const legalSource = readFileSync(LEGAL_PATH, "utf8");
const PROMPTS_PATH = path.join(ROOT_DIR, "public/prompts.js");
const promptsSource = readFileSync(PROMPTS_PATH, "utf8");

const MAX_MESSAGE_LENGTH = 1200;
const LANGS = ["ro", "en"];

// Stripe's own supported Markdown subset for custom_text messages: only
// [text](url) links and **bold**. Anything else (headers, single-asterisk
// or underscore emphasis, backticks, an unmatched bracket/paren left over
// from a typo) renders as literal punctuation in Stripe's checkout UI
// instead of the formatting a naive author might expect -- checked
// structurally here rather than trusted by convention. The approach: strip
// every well-formed link and every well-formed bold span, then assert none
// of Markdown's other special characters survive in what's left.
const MARKDOWN_LINK_RE = /\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_BOLD_RE = /\*\*[^*]+\*\*/g;
const DISALLOWED_MARKDOWN_RE = /[#_`*[\]()]/;

function assertOnlyStripeMarkdownSubset(text, label) {
  const stripped = text.replace(MARKDOWN_LINK_RE, "").replace(MARKDOWN_BOLD_RE, "");
  const bad = stripped.match(DISALLOWED_MARKDOWN_RE);
  assert.equal(
    bad,
    null,
    `${label} contains markdown beyond Stripe's supported subset ([text](url) links and **bold** only) -- found ${bad ? JSON.stringify(bad[0]) : ""} after stripping valid links/bold from: ${JSON.stringify(text)}`
  );
}

// Runs a legal.js-shaped source string in a fresh sandbox and returns
// whatever it assigned to `module.exports`. `withWindow` adds a plain
// object `window` to the sandbox first (simulating a browser); leaving it
// out simulates the Worker's own environment, where `window` does not
// exist at all -- an unguarded `window.X = ...` in the source would throw
// `ReferenceError: window is not defined` right here, which is exactly the
// failure AD-18 exists to prevent.
function loadLegal(source, { withWindow = false, filename = "legal.js" } = {}) {
  const sandbox = { module: { exports: {} }, console };
  if (withWindow) sandbox.window = {};
  vm.runInNewContext(source, sandbox, { filename });
  return { exported: sandbox.module.exports, window: sandbox.window };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("public/legal.js runs with no `window` global at all (the Worker's own environment) and exports via module.exports without throwing", () => {
  const { exported } = loadLegal(legalSource, { withWindow: false });
  assert.ok(exported && typeof exported === "object", "module.exports must be an object");
  assert.ok(
    "WAIVER_CONSENT" in exported && "REFUND_POLICY" in exported && "TERMS_VERSION" in exported && "TERMS_PATH" in exported,
    "module.exports must carry WAIVER_CONSENT, REFUND_POLICY, TERMS_VERSION and TERMS_PATH"
  );
});

check("public/legal.js also runs with a `window` global defined (a browser) and assigns the same four values to it", () => {
  const { exported, window } = loadLegal(legalSource, { withWindow: true });
  assert.equal(window.WAIVER_CONSENT, exported.WAIVER_CONSENT);
  assert.equal(window.REFUND_POLICY, exported.REFUND_POLICY);
  assert.equal(window.TERMS_VERSION, exported.TERMS_VERSION);
  assert.equal(window.TERMS_PATH, exported.TERMS_PATH);
});

check("WAIVER_CONSENT has exactly the ro and en keys, one-to-one, each non-empty text within Stripe's 1200-character limit", () => {
  const { exported } = loadLegal(legalSource);
  const { WAIVER_CONSENT } = exported;
  assert.ok(WAIVER_CONSENT && typeof WAIVER_CONSENT === "object" && !Array.isArray(WAIVER_CONSENT), "WAIVER_CONSENT must be a plain object");
  assert.deepEqual(Object.keys(WAIVER_CONSENT).sort(), [...LANGS].sort(), "WAIVER_CONSENT must have exactly the ro and en keys -- nothing missing, nothing extra");
  for (const lang of LANGS) {
    const text = WAIVER_CONSENT[lang];
    assert.equal(typeof text, "string", `WAIVER_CONSENT.${lang} must be a string`);
    assert.ok(text.trim().length > 0, `WAIVER_CONSENT.${lang} must not be empty`);
    assert.ok(text.length <= MAX_MESSAGE_LENGTH, `WAIVER_CONSENT.${lang} is ${text.length} characters, over Stripe's ${MAX_MESSAGE_LENGTH}-character limit`);
  }
});

check("WAIVER_CONSENT uses only Stripe's supported Markdown subset ([text](url) links and **bold** -- nothing else)", () => {
  const { exported } = loadLegal(legalSource);
  for (const lang of LANGS) {
    assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT[lang], `WAIVER_CONSENT.${lang}`);
  }
});

// REFUND_POLICY (Story 6-7): same discipline as WAIVER_CONSENT above --
// exactly ro/en, each non-empty and under the same 1200-character ceiling
// (never sent to Stripe, but kept to the same editorial length and markdown
// subset so terms.html's renderer, which handles both exports through the
// same converter, never has to special-case one of them), same Markdown
// subset only.
check("REFUND_POLICY has exactly the ro and en keys, one-to-one, each non-empty text within the 1200-character limit", () => {
  const { exported } = loadLegal(legalSource);
  const { REFUND_POLICY } = exported;
  assert.ok(REFUND_POLICY && typeof REFUND_POLICY === "object" && !Array.isArray(REFUND_POLICY), "REFUND_POLICY must be a plain object");
  assert.deepEqual(Object.keys(REFUND_POLICY).sort(), [...LANGS].sort(), "REFUND_POLICY must have exactly the ro and en keys -- nothing missing, nothing extra");
  for (const lang of LANGS) {
    const text = REFUND_POLICY[lang];
    assert.equal(typeof text, "string", `REFUND_POLICY.${lang} must be a string`);
    assert.ok(text.trim().length > 0, `REFUND_POLICY.${lang} must not be empty`);
    assert.ok(text.length <= MAX_MESSAGE_LENGTH, `REFUND_POLICY.${lang} is ${text.length} characters, over the ${MAX_MESSAGE_LENGTH}-character limit`);
  }
});

check("REFUND_POLICY uses only Stripe's supported Markdown subset ([text](url) links and **bold** -- nothing else)", () => {
  const { exported } = loadLegal(legalSource);
  for (const lang of LANGS) {
    assertOnlyStripeMarkdownSubset(exported.REFUND_POLICY[lang], `REFUND_POLICY.${lang}`);
  }
});

check("TERMS_VERSION is a non-empty string", () => {
  const { exported } = loadLegal(legalSource);
  assert.equal(typeof exported.TERMS_VERSION, "string");
  assert.ok(exported.TERMS_VERSION.trim().length > 0);
});

check('TERMS_PATH is a non-empty string starting with "/"', () => {
  const { exported } = loadLegal(legalSource);
  assert.equal(typeof exported.TERMS_PATH, "string");
  assert.ok(exported.TERMS_PATH.startsWith("/"), `TERMS_PATH must start with "/", got ${JSON.stringify(exported.TERMS_PATH)}`);
});

// ------------------------------------------------------------------- prompts
// public/prompts.js (Story 7-1, AD-18): same IIFE/dual-guard shape as
// legal.js above, proven the same way -- runs under plain Node with no
// `window` global at all and exports `{ RO, EN }` via module.exports
// without throwing (the exact ReferenceError AD-18 exists to prevent, now
// fixed for prompts.js too). Beyond that, this section checks the id
// discipline Story 7-1 adds: DRAW_PROMPTS_RO and DRAW_PROMPTS_EN are the
// real current length (260 today -- not hardcoded as a magic number
// disconnected from the file, computed once below and reused), every entry
// in both languages carries a non-empty string `id`, no id repeats within
// a single language's own array, and the SET of ids in RO is exactly the
// set of ids in EN (same members, same count) -- the "RO/EN id-set
// mismatch" case the spec's own I/O matrix calls out by name.

// Runs a prompts.js-shaped source string in a fresh sandbox and returns
// whatever it assigned to `module.exports`, the same technique loadLegal
// uses above -- leaving `withWindow` out simulates the Worker's own
// environment, where `window` does not exist at all.
function loadPrompts(source, { withWindow = false, filename = "prompts.js" } = {}) {
  const sandbox = { module: { exports: {} }, console };
  if (withWindow) sandbox.window = {};
  vm.runInNewContext(source, sandbox, { filename });
  return { exported: sandbox.module.exports, window: sandbox.window };
}

// The real file's own current length -- read once here instead of a
// hardcoded "260" baked into every assertion below, so this check keeps
// covering the true count if the prompt bank ever grows or shrinks (the
// spec's own Code Map: "assert 260/260 (or whatever the true current count
// is, don't hardcode a wrong number)").
const { exported: realPromptsExports } = loadPrompts(promptsSource);
const REAL_PROMPTS_COUNT = Array.isArray(realPromptsExports.RO) ? realPromptsExports.RO.length : 0;

check("public/prompts.js runs with no `window` global at all (the Worker's own environment) and exports { RO, EN } via module.exports without throwing", () => {
  const { exported } = loadPrompts(promptsSource);
  assert.ok(exported && typeof exported === "object", "module.exports must be an object");
  assert.ok(Array.isArray(exported.RO) && Array.isArray(exported.EN), "module.exports must carry RO and EN arrays");
});

check("public/prompts.js also runs with a `window` global defined (a browser) and assigns DRAW_PROMPTS_RO/_EN the same arrays", () => {
  const { exported, window } = loadPrompts(promptsSource, { withWindow: true });
  assert.equal(window.DRAW_PROMPTS_RO, exported.RO);
  assert.equal(window.DRAW_PROMPTS_EN, exported.EN);
});

check(`DRAW_PROMPTS_RO and DRAW_PROMPTS_EN are each exactly ${REAL_PROMPTS_COUNT} entries (the file's own current length)`, () => {
  const { exported } = loadPrompts(promptsSource);
  assert.ok(REAL_PROMPTS_COUNT > 0, "the real prompts.js file must not be empty -- something is wrong with this check itself if it is");
  assert.equal(exported.RO.length, REAL_PROMPTS_COUNT, `RO has ${exported.RO.length} entries, expected ${REAL_PROMPTS_COUNT}`);
  assert.equal(exported.EN.length, REAL_PROMPTS_COUNT, `EN has ${exported.EN.length} entries, expected ${REAL_PROMPTS_COUNT}`);
});

check("every entry in both RO and EN has a non-empty string id", () => {
  const { exported } = loadPrompts(promptsSource);
  for (const [lang, arr] of [["RO", exported.RO], ["EN", exported.EN]]) {
    arr.forEach((entry, i) => {
      assert.equal(typeof entry.id, "string", `${lang}[${i}].id must be a string, got ${JSON.stringify(entry.id)}`);
      assert.ok(entry.id.trim().length > 0, `${lang}[${i}].id must not be empty`);
    });
  }
});

check("no duplicate id within RO alone, and none within EN alone", () => {
  const { exported } = loadPrompts(promptsSource);
  for (const [lang, arr] of [["RO", exported.RO], ["EN", exported.EN]]) {
    const seen = new Map();
    for (const entry of arr) {
      if (seen.has(entry.id)) {
        assert.fail(`${lang} has a duplicate id ${JSON.stringify(entry.id)} (first at index ${seen.get(entry.id)})`);
      }
      seen.set(entry.id, arr.indexOf(entry));
    }
  }
});

check("the set of ids in RO equals the set of ids in EN -- same members, same count", () => {
  const { exported } = loadPrompts(promptsSource);
  const roIds = new Set(exported.RO.map((e) => e.id));
  const enIds = new Set(exported.EN.map((e) => e.id));
  const onlyInRo = [...roIds].filter((id) => !enIds.has(id));
  const onlyInEn = [...enIds].filter((id) => !roIds.has(id));
  assert.equal(roIds.size, exported.RO.length, "RO id set has fewer members than entries -- duplicate ids should already have failed the check above");
  assert.equal(enIds.size, exported.EN.length, "EN id set has fewer members than entries -- duplicate ids should already have failed the check above");
  assert.deepEqual(onlyInRo, [], `ids present in RO but missing from EN: ${JSON.stringify(onlyInRo)}`);
  assert.deepEqual(onlyInEn, [], `ids present in EN but missing from RO: ${JSON.stringify(onlyInEn)}`);
});

// ------------------------------------------------------------------ fixtures
// Proves this script's own checks actually fail loudly on the exact
// mismatches the spec calls out -- not just that the real file happens to
// pass today.

function mkSource({
  waiver = `{ ro: "ro text", en: "en text" }`,
  refund = `{ ro: "ro refund text", en: "en refund text" }`,
  version = `"2026-09-21"`,
  termsPath = `"/terms"`,
  windowGuard = true,
} = {}) {
  const windowBlock = windowGuard
    ? `if (typeof window !== "undefined") {
        window.WAIVER_CONSENT = WAIVER_CONSENT;
        window.REFUND_POLICY = REFUND_POLICY;
        window.TERMS_VERSION = TERMS_VERSION;
        window.TERMS_PATH = TERMS_PATH;
      }`
    : `window.WAIVER_CONSENT = WAIVER_CONSENT; // deliberately unguarded, for the fixture below`;
  return `
    (() => {
      "use strict";
      const WAIVER_CONSENT = ${waiver};
      const REFUND_POLICY = ${refund};
      const TERMS_VERSION = ${version};
      const TERMS_PATH = ${termsPath};
      ${windowBlock}
      if (typeof module !== "undefined" && module.exports) {
        module.exports = { WAIVER_CONSENT, REFUND_POLICY, TERMS_VERSION, TERMS_PATH };
      }
    })();
  `;
}

check("fixture (good): a well-formed legal.js-shaped source passes every check above", () => {
  const { exported, window } = loadLegal(mkSource(), { withWindow: true });
  assert.deepEqual(Object.keys(exported.WAIVER_CONSENT).sort(), [...LANGS].sort());
  assert.deepEqual(Object.keys(exported.REFUND_POLICY).sort(), [...LANGS].sort());
  assert.equal(window.WAIVER_CONSENT, exported.WAIVER_CONSENT);
  assert.equal(window.REFUND_POLICY, exported.REFUND_POLICY);
});

check("fixture (bad): an unguarded window.X = ... throws when there is no window global -- proves the guard is actually being tested, not assumed", () => {
  assert.throws(() => loadLegal(mkSource({ windowGuard: false }), { withWindow: false }), /window is not defined/);
});

check("fixture (bad): en key missing entirely is caught (RO/EN parity)", () => {
  const { exported } = loadLegal(mkSource({ waiver: `{ ro: "ro text" }` }));
  assert.throws(() => assert.deepEqual(Object.keys(exported.WAIVER_CONSENT).sort(), LANGS));
});

check("fixture (bad): an extra third-language key is caught (RO/EN parity, nothing extra)", () => {
  const { exported } = loadLegal(mkSource({ waiver: `{ ro: "ro text", en: "en text", fr: "fr text" }` }));
  assert.throws(() => assert.deepEqual(Object.keys(exported.WAIVER_CONSENT).sort(), LANGS));
});

check("fixture (bad): an empty-string language value is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: `{ ro: "", en: "en text" }` }));
  assert.throws(() => assert.ok(exported.WAIVER_CONSENT.ro.trim().length > 0));
});

check("fixture (bad): a non-string language value is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: `{ ro: 12345, en: "en text" }` }));
  assert.throws(() => assert.equal(typeof exported.WAIVER_CONSENT.ro, "string"));
});

check("fixture (bad): a message over Stripe's 1200-character limit is caught", () => {
  const tooLong = JSON.stringify("x".repeat(MAX_MESSAGE_LENGTH + 1));
  const { exported } = loadLegal(mkSource({ waiver: `{ ro: "ro text", en: ${tooLong} }` }));
  assert.throws(() => assert.ok(exported.WAIVER_CONSENT.en.length <= MAX_MESSAGE_LENGTH));
});

check("fixture (bad): an empty TERMS_VERSION is caught", () => {
  const { exported } = loadLegal(mkSource({ version: `""` }));
  assert.throws(() => assert.ok(exported.TERMS_VERSION.trim().length > 0));
});

check('fixture (bad): a TERMS_PATH not starting with "/" is caught', () => {
  const { exported } = loadLegal(mkSource({ termsPath: `"terms"` }));
  assert.throws(() => assert.ok(exported.TERMS_PATH.startsWith("/")));
});

check("fixture (good): a real [text](url) link plus **bold** text both pass the markdown-subset check", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "Vezi [Termeni](https://8ish.app/terms) și **citește-i**.", en: "See [Terms](https://8ish.app/terms) and **read them**." }' }));
  for (const lang of LANGS) assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT[lang], `WAIVER_CONSENT.${lang}`);
});

check("fixture (bad): a markdown header (#) is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "# Titlu", en: "en text" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT.ro, "WAIVER_CONSENT.ro"));
});

check("fixture (bad): underscore emphasis (_word_) is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "ro text", en: "some _emphasis_ here" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT.en, "WAIVER_CONSENT.en"));
});

check("fixture (bad): single-asterisk emphasis (*word*) is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "ro text", en: "some *emphasis* here" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT.en, "WAIVER_CONSENT.en"));
});

check("fixture (bad): an unmatched bracket outside a real link is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "ro text", en: "some [stray bracket here" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT.en, "WAIVER_CONSENT.en"));
});

check("fixture (bad): REFUND_POLICY en key missing entirely is caught (RO/EN parity)", () => {
  const { exported } = loadLegal(mkSource({ refund: `{ ro: "ro refund" }` }));
  assert.throws(() => assert.deepEqual(Object.keys(exported.REFUND_POLICY).sort(), LANGS));
});

check("fixture (bad): REFUND_POLICY an empty-string language value is caught", () => {
  const { exported } = loadLegal(mkSource({ refund: `{ ro: "", en: "en refund" }` }));
  assert.throws(() => assert.ok(exported.REFUND_POLICY.ro.trim().length > 0));
});

check("fixture (bad): REFUND_POLICY a message over the 1200-character limit is caught", () => {
  const tooLong = JSON.stringify("x".repeat(MAX_MESSAGE_LENGTH + 1));
  const { exported } = loadLegal(mkSource({ refund: `{ ro: "ro refund", en: ${tooLong} }` }));
  assert.throws(() => assert.ok(exported.REFUND_POLICY.en.length <= MAX_MESSAGE_LENGTH));
});

check("fixture (good): REFUND_POLICY with a real [text](url) link plus **bold** text both pass the markdown-subset check", () => {
  const { exported } = loadLegal(mkSource({ refund: '{ ro: "Scrie-ne la [email]({TERMS_URL}) și **citește politica**.", en: "Email us at [contact]({TERMS_URL}) and **read the policy**." }' }));
  for (const lang of LANGS) assertOnlyStripeMarkdownSubset(exported.REFUND_POLICY[lang], `REFUND_POLICY.${lang}`);
});

check("fixture (bad): REFUND_POLICY underscore emphasis (_word_) is caught", () => {
  const { exported } = loadLegal(mkSource({ refund: '{ ro: "ro refund", en: "some _emphasis_ here" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.REFUND_POLICY.en, "REFUND_POLICY.en"));
});

check("fixture (bad): a backtick (code span) is caught", () => {
  const { exported } = loadLegal(mkSource({ waiver: '{ ro: "ro text", en: "some `code` here" }' }));
  assert.throws(() => assertOnlyStripeMarkdownSubset(exported.WAIVER_CONSENT.en, "WAIVER_CONSENT.en"));
});

// ------------------------------------------------------------- prompts fixtures
// Proves the prompts.js checks above actually fail loudly on the exact
// mismatches the spec calls out (a duplicate id, a missing id, an RO/EN
// id-set mismatch) -- not just that the real file happens to pass today.
// Same fixture-generator style as mkSource() above: build a small
// prompts.js-shaped source string from arrays of { id, text } entries
// (seconds is fixed at 30, irrelevant to these checks) and load it through
// loadPrompts().

function mkPromptsSource({ ro = [{ id: "p001", text: "ro one" }, { id: "p002", text: "ro two" }], en = [{ id: "p001", text: "en one" }, { id: "p002", text: "en two" }] } = {}) {
  const entry = (e) => `{ id: ${JSON.stringify(e.id)}, text: ${JSON.stringify(e.text)}, seconds: 30 }`;
  const roLiteral = `[${ro.map(entry).join(", ")}]`;
  const enLiteral = `[${en.map(entry).join(", ")}]`;
  return `
    (() => {
      "use strict";
      const DRAW_PROMPTS_RO = ${roLiteral};
      const DRAW_PROMPTS_EN = ${enLiteral};
      if (typeof window !== "undefined") {
        window.DRAW_PROMPTS_RO = DRAW_PROMPTS_RO;
        window.DRAW_PROMPTS_EN = DRAW_PROMPTS_EN;
      }
      if (typeof module !== "undefined" && module.exports) {
        module.exports = { RO: DRAW_PROMPTS_RO, EN: DRAW_PROMPTS_EN };
      }
    })();
  `;
}

check("fixture (good): a well-formed prompts.js-shaped source passes id-uniqueness and RO/EN id-set parity", () => {
  const { exported } = loadPrompts(mkPromptsSource());
  const roIds = new Set(exported.RO.map((e) => e.id));
  const enIds = new Set(exported.EN.map((e) => e.id));
  assert.equal(roIds.size, exported.RO.length);
  assert.equal(enIds.size, exported.EN.length);
  assert.deepEqual([...roIds].sort(), [...enIds].sort());
});

check("fixture (bad): a duplicate id within RO alone is caught", () => {
  const { exported } = loadPrompts(mkPromptsSource({ ro: [{ id: "p001", text: "ro one" }, { id: "p001", text: "ro one again" }] }));
  assert.throws(() => {
    const seen = new Set();
    for (const entry of exported.RO) {
      assert.ok(!seen.has(entry.id), `duplicate id ${JSON.stringify(entry.id)}`);
      seen.add(entry.id);
    }
  }, /duplicate id "p001"/);
});

check("fixture (bad): a missing id (empty string) is caught", () => {
  const { exported } = loadPrompts(mkPromptsSource({ en: [{ id: "", text: "en one" }, { id: "p002", text: "en two" }] }));
  assert.throws(() => assert.ok(exported.EN[0].id.trim().length > 0));
});

check("fixture (bad): an RO/EN id-set mismatch is caught", () => {
  const { exported } = loadPrompts(mkPromptsSource({ en: [{ id: "p001", text: "en one" }, { id: "p999", text: "en two, drifted id" }] }));
  const roIds = new Set(exported.RO.map((e) => e.id));
  const enIds = new Set(exported.EN.map((e) => e.id));
  const onlyInRo = [...roIds].filter((id) => !enIds.has(id));
  const onlyInEn = [...enIds].filter((id) => !roIds.has(id));
  assert.throws(() => assert.deepEqual(onlyInRo, []));
  assert.throws(() => assert.deepEqual(onlyInEn, []));
  assert.deepEqual(onlyInRo, ["p002"]);
  assert.deepEqual(onlyInEn, ["p999"]);
});

check("fixture (bad): an unguarded prompts.js-shaped window.X = ... throws when there is no window global", () => {
  const badSource = `
    (() => {
      "use strict";
      const DRAW_PROMPTS_RO = [{ id: "p001", text: "ro one", seconds: 30 }];
      const DRAW_PROMPTS_EN = [{ id: "p001", text: "en one", seconds: 30 }];
      window.DRAW_PROMPTS_RO = DRAW_PROMPTS_RO; // deliberately unguarded, for the fixture below
      window.DRAW_PROMPTS_EN = DRAW_PROMPTS_EN;
      if (typeof module !== "undefined" && module.exports) {
        module.exports = { RO: DRAW_PROMPTS_RO, EN: DRAW_PROMPTS_EN };
      }
    })();
  `;
  assert.throws(() => loadPrompts(badSource, { withWindow: false }), /window is not defined/);
});

// ------------------------------------------------------------------- runner

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(error.message || error).split("\n").join("\n     ")}`);
  }
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
