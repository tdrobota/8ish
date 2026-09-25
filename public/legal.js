// legal.js — single source of truth for the Waiver consent text, the
// refund-policy text, the Terms version and the Terms path (AD-18: shared
// data files have one source of truth). Story 6-4 (checkout) reads
// WAIVER_CONSENT to build the Stripe Checkout Session's
// `custom_text[terms_of_service_acceptance][message]`; the paywall (Story
// 6-5) and the Terms page itself (Story 6-7) are meant to read the same
// values later, so the wording a parent sees at checkout, on the paywall's
// disclosure and on the Terms page can never drift apart the way
// independently-typed copies would.
//
// REFUND_POLICY (Story 6-7) is the same idea applied to the fix-or-refund
// guarantee and refund timing: terms.html renders it from here, at load
// time, instead of a second hand-typed paragraph. Unlike WAIVER_CONSENT it
// is never sent to Stripe (nothing in checkout.js reads it) — it exists
// purely so terms.html has one source of truth instead of its own copy.
//
// One IIFE, guarded on both sides — the exact fix AD-18 records for
// prompts.js's own bug: a plain top-level `window.X = ...` throws
// `ReferenceError: window is not defined` the instant a Worker imports the
// file (reproduced against esbuild during architecture review), which would
// take down every /api/* route, not just checkout. Guarding this file the
// same way means:
//   - it assigns to `window` only when `typeof window !== "undefined"`
//     (true in the browser, false in the Worker) — never in the Worker;
//   - it exports through a `typeof module !== "undefined" && module.exports`
//     guard (true under plain Node and the Worker's CJS-in-ESM bundling,
//     false in the browser, which has no `module`) — never in the browser.
// The same physical file is therefore both a classic <script src="legal.js">
// and `import`able as `import legal from "../../public/legal.js"` from
// functions/api/checkout.js (default interop = module.exports, the same
// pattern AD-18 specifies for prompts.js). scripts/check-bundle.mjs proves
// this against the real esbuild bundler checkout.js is actually built with
// (see that script's own header comment and docs/runbook.md §1.6).
//
// WAIVER_CONSENT and REFUND_POLICY are both developer DRAFTs (spec-6-4's
// Design Notes, extended by spec-6-7): the exact legal wording of both is
// pending the owner sending it to a lawyer or the consumer-protection
// authority (docs/runbook.md's "pending legal review" flag, which blocks
// Epic 9's go/no-go) — copied here verbatim, not paraphrased. Each
// language's text, for both exports, is kept comfortably under 1200
// characters (WAIVER_CONSENT: Stripe's own limit for
// `custom_text[...][message]`; REFUND_POLICY reuses the same ceiling purely
// for a consistent editorial length, since it is never sent to Stripe), and
// uses only Stripe's supported Markdown subset ([text](url) links and
// **bold**) — both checked by scripts/check-shared.mjs, which fails loudly
// if either language of either export goes missing, empty, over the limit,
// or uses any other markdown construct.
//
// Two things this file deliberately does NOT hardcode, to stay a genuine
// single source of truth instead of just moving the duplication here:
//   - The Terms URL. WAIVER_CONSENT's link target is the literal token
//     `{TERMS_URL}`, not a real URL — env.ORIGIN is only known once a
//     request actually arrives (checkout.js reads it from `env`, the same
//     trusted var lib/turnstile.js already requires for its own hostname
//     check), so baking in one fixed domain here would either hardcode
//     production into every environment or duplicate checkout.js's own
//     ORIGIN-only discipline in a second place. checkout.js substitutes
//     `env.ORIGIN + TERMS_PATH` for this token immediately before sending
//     the message to Stripe; nothing else in this repo may send
//     WAIVER_CONSENT to Stripe, or display it, with the placeholder still
//     in it.
//   - The human-readable date. "21 septembrie 2026" / "September 21, 2026"
//     are derived from TERMS_VERSION below via Intl.DateTimeFormat, not
//     hand-typed a second time — otherwise nothing would stop the display
//     date, TERMS_VERSION, and the two languages' dates from silently
//     drifting apart from each other. Intl is available in every
//     environment this file runs in (browsers, plain Node, and the
//     Cloudflare Workers runtime, which is V8-based with full ICU) — not
//     separately verified against a real Workers deploy (see
//     docs/runbook.md §1.6).
(() => {
  "use strict";

  // ISO 8601, language-independent — the one value every date in this file
  // derives from. Matches terms.html's own "Last updated" date (Story 3.5);
  // Story 6.7 updates both together when the real legal pages replace the
  // interim text.
  const TERMS_VERSION = "2026-09-21";

  // The production redirect TARGET, not the .html filename. This is
  // Cloudflare's assets-layer `html_handling` default ("auto-trailing-slash",
  // which also drops a matching file's `.html` extension) — confirmed via
  // curl during Story 3.1 against the deployed site, not something
  // public/sw.js itself decides (sw.js only caches/serves whatever URL the
  // assets layer already resolved the navigation to; see scripts/check-public.mjs's
  // own comment on the same default for the general rule this follows).
  const TERMS_PATH = "/terms";

  function formatTermsDate(locale) {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${TERMS_VERSION}T00:00:00Z`)
    );
  }

  const WAIVER_CONSENT = {
    ro: `Sunt de acord ca accesul la 8ish+ să înceapă imediat după plată. Știu că, prin această alegere, renunț la dreptul de retragere de 14 zile pentru servicii digitale odată ce folosesc efectiv abonamentul. Am citit [Termenii și condițiile]({TERMS_URL}). Versiune Termeni: ${formatTermsDate("ro-RO")}.`,
    en: `I agree that access to 8ish+ starts immediately after payment. I understand that, by choosing this, I give up my 14-day right of withdrawal for digital services once I actually use the subscription. I have read the [Terms and Conditions]({TERMS_URL}). Terms version: ${formatTermsDate("en-US")}.`,
  };

  // REFUND_POLICY (Story 6-7): the fix-or-refund guarantee plus refund
  // timing, rendered on terms.html the same way WAIVER_CONSENT is. No
  // `{TERMS_URL}` token here — unlike the Waiver, this text carries no link
  // that depends on the request's own origin.
  const REFUND_POLICY = {
    ro: `Dacă o funcție esențială a 8ish+ este defectă din punct de vedere tehnic și te împiedică să folosești aplicația așa cum este descrisă, o **reparăm** sau îți **rambursăm** integral suma plătită. O cerere de rambursare este confirmată, de regulă, în cel mult 2 zile lucrătoare. Pentru planul anual, poți cere rambursarea integrală a unei taxe de reînnoire în termen de 7 zile de la data acelei reînnoiri, separat de dreptul de retragere de 14 zile. Pentru orice cerere de rambursare, scrie-ne la 8siceva@gmail.com.`,
    en: `If an essential 8ish+ feature is technically broken and stops you from using the app as described, we'll **fix** it or **refund** what you paid in full. A refund request is normally confirmed within 2 business days. For the yearly plan, you can request a full refund of a renewal charge within 7 days of that renewal, separate from the 14-day right of withdrawal. For any refund request, email us at 8siceva@gmail.com.`,
  };

  if (typeof window !== "undefined") {
    window.WAIVER_CONSENT = WAIVER_CONSENT;
    window.REFUND_POLICY = REFUND_POLICY;
    window.TERMS_VERSION = TERMS_VERSION;
    window.TERMS_PATH = TERMS_PATH;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { WAIVER_CONSENT, REFUND_POLICY, TERMS_VERSION, TERMS_PATH };
  }
})();
