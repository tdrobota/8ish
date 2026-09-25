# Runbook

This file is the single reference for everything about this deployment that
lives only in the Cloudflare dashboard, the Stripe dashboard, or the owner's
memory — never in the repo's code. It lives at `docs/runbook.md`, outside
`public/`, and is never served: `scripts/check-public.mjs` proves `/docs/runbook.md`
answers `404` on a running site.

It records the **shape** of each dashboard-only item and secret — where it
lives, how to check it, how to undo or rotate it — not real values. Real
values (an actual WAF rule expression, a real promo code, a live token) are
the owner's to fill in locally or in the dashboards themselves; none belong
in this file or anywhere else in the repo.

Conventions used below:

- **live today** — this repo's code (`functions/`) already reads it, or the
  dashboard state already exists and matters right now.
- **planned, Epic N** — nothing in this repo references it yet; it is built
  in a later epic. Do not act on it as if it exists.

For the current committed shape of the Worker (name, routes, KV binding,
vars), read `wrangler.jsonc` at the repo root — this file describes it, it
does not duplicate the values.

**The Spend Governor (Story 7-2, live today):** a single SQLite-backed
Durable Object, `Governor` (`functions/governor.js`, bound as `GOVERNOR` in
`wrangler.jsonc`), is now part of this Worker — it holds every spend
counter the app will ever have. This story builds only the generic
reserve/commit/release engine and its accounting; nothing in the app calls
it yet (Story 7.5 wires the Image endpoint to it), and it has no
owner-facing dashboard action of its own — everything about it lives in
code and is covered by `node --test`, not this file. §5 below notes the one
thing that does matter operationally once any Durable Object exists:
migrations are additive-only and `wrangler rollback` cannot undo one.

**Config & Kill Switch (Story 7-4, live today as code — no caller yet):**
`functions/lib/governor-config.js` is now the source of the Governor's `cfg`
object: it checks the `AI_ENABLED` Worker var first (zero KV calls if it
isn't exactly `"true"`), then a 30s in-isolate cache, then
`STATE_KV`'s `cfg:governor` key (sourced from the committed
`config/governor.json`), validating the whole object atomically — one
field missing or wrong-typed fails the entire config closed. Still no
caller reads it (Story 7.5's job) and nothing has been pushed to a real KV
namespace from this session. §1.2–§1.4 below are this story's three
owner-facing dashboard actions: the `AI_ENABLED` var flip, the `cfg:governor`
KV push/read commands, and the WAF backup rule. §9 is the kill-switch drill
template.

---

## 1. Dashboard-only items

### 1.1 Cloudflare WAF — rate-limit rule

- **Status:** the exact setup steps below are now documented (Story 7-8,
  AD-23) — the rule itself is still NOT created in any real Cloudflare
  account by this or any prior story (this repo has no live dashboard
  access; documentation only, per this story's own "Never" constraint).
  Creating and enabling it for real remains an owner-executed dashboard
  action, gated as an Epic 9 go-live precondition alongside Story 7-9's own
  abuse-check run. This is a DIFFERENT rule from §1.2 just below — read that
  section's own status line for the distinction: §1.2 is a *disabled,
  block-all* rule scoped to `/api/transform` alone (Story 7-4's Kill Switch
  backup method, toggled on only during a real incident or drill); this
  §1.1 rule is an *always-on rate limiter* scoped to `/api/*` generally
  (excluding `/api/e`), never disabled during normal operation. Do not
  confuse or merge the two — they serve different purposes, have different
  match expressions, and different default states (this one always
  enabled; §1.2 normally disabled).
- **Where it lives:** Cloudflare dashboard → the `8ish.app` zone → Security →
  WAF → Rate limiting rules (a different screen from §1.2's own Custom
  rules screen).
- **Shape (from architecture AD-23):** one rule, per-IP, 10-second window,
  matching `starts_with(http.request.uri.path, "/api/")` and excluding
  `/api/e`, threshold 6 requests per 10 s (a normal app open makes at most
  3). This is a per-IP control only — weak against IPv6 rotation and
  botnets — and is never the sole protection of a shared quota (the
  Governor, Epic 7, is that protection).
- **How to set it up (owner-executed, exact steps):**
  1. Cloudflare dashboard → the `8ish.app` zone → Security → WAF → Rate
     limiting rules → Create rule.
  2. Name it something unambiguous, e.g. `api-rate-limit` or
     `rate-limit-api-except-events`.
  3. **When incoming requests match:** custom filter expression —
     `(starts_with(http.request.uri.path, "/api/") and not
     starts_with(http.request.uri.path, "/api/e"))`. (`/api/e` is the
     events endpoint, Epic 8's own job — AD-23 explicitly names it as an
     *unthrottled* surface, out of scope for both this rule and this
     story.)
  4. **Rate limiting parameters:** Period — 10 seconds. Requests — 6.
     Characteristic to track — IP address (the default; do not switch this
     to a header or cookie value — AD-16/this app's whole design reads no
     cookie and no IP-derived identity anywhere in application code, but
     Cloudflare's own WAF layer tracking the connecting IP for THIS rule is
     a platform-level control, not application code, and is exactly what
     AD-23 specifies).
  5. **Then:** Block, for however long the dashboard's own default
     mitigation timeout is (the standard "block for N seconds" behavior) —
     no custom response body needed; a generic 429 from Cloudflare's edge is
     sufficient (the app's own `/api/*` endpoints already return their own
     `{error:{code}}` JSON envelope on every real path they reach — a
     WAF-level block never reaches the Worker at all, so the two responses
     are never seen by the same caller in the same place).
  6. Deploy the rule enabled (unlike §1.2's own pre-made-but-disabled
     kill-switch rule, this one runs continuously as a standing defense —
     there is no "drill" step for this one, it is simply on).
- **How to verify once created:** send 7+ rapid requests to any `/api/*`
  path except `/api/e` from one IP inside 10 s; the 7th+ should be blocked
  by Cloudflare before it reaches the Worker (visible in the WAF rule's
  Security Events log, not in `wrangler tail`). Story 7-9's own
  `scripts/abuse-check.mjs` post-deploy mode is expected to include this
  exact scenario as one of its "safe checks against real production" (per
  epic-7-context.md's own abuse-checks summary: "WAF burst → 429").
- **How to undo:** disable or delete the rule in the same dashboard screen;
  takes effect immediately.

### 1.2 Cloudflare WAF — Kill Switch backup rule

- **Status:** the WAF rule itself is still a dashboard-only owner action,
  not created in this session (unchanged — this story documents it, it
  cannot create it: no live Cloudflare dashboard access here). Story 7-4
  built the *code* side of the other two layers (§1.3, §1.4); this rule is
  AD-14's third, Worker-independent switch, and is also listed as an Epic 9
  go-live precondition (AD-9).
- **Where it lives:** Cloudflare dashboard → the `8ish.app` zone → Security →
  WAF → Custom rules.
- **How to set it up (owner-executed):**
  1. Cloudflare dashboard → the `8ish.app` zone → Security → WAF → Custom
     rules → Create rule.
  2. Name it something unambiguous, e.g. `kill-switch-transform` or
     `emergency-block-transform`.
  3. Field: `URI Path` — Operator: `equals` — Value: `/api/transform`
     (or an expression: `http.request.uri.path eq "/api/transform"`).
  4. Action: **Block**.
  5. Leave the rule **disabled** (the toggle next to it) — save it in that
     state. It must stay disabled during normal operation; only enabling it
     during a real incident (or a drill, §9) is the point of pre-making it
     now rather than authoring it from scratch under pressure.
- **How to enable it as the third kill-switch method (owner-executed, during
  an incident or a drill):**
  1. Cloudflare dashboard → the same WAF → Custom rules screen.
  2. Toggle the pre-made rule to **enabled**. Takes effect immediately —
     Cloudflare enforces WAF custom rules at the edge, before any request
     reaches the Worker, so this works even if the Worker itself is
     unreachable or `AI_ENABLED` somehow failed to take effect.
  3. Confirm: a request to `/api/transform` should get Cloudflare's own
     block response, visible in the rule's Security Events log — not in
     `wrangler tail` (the request never reaches the Worker at all).
- **How to undo (turn spend back on):** disable the rule in the same
  dashboard screen; takes effect immediately.

### 1.3 Cloudflare Worker var — `AI_ENABLED` (the emergency Kill Switch)

- **Status:** live today as code, and genuinely wired up (Stories 7-4 through
  7-7). `functions/lib/governor-config.js` checks `env.AI_ENABLED` first,
  before any KV call — anything other than the literal string `"true"`
  (unset, `"false"`, any typo, wrong case) fails Image spend closed with
  zero KV I/O; `functions/api/transform.js` is the real caller (both the
  subscriber and free-device paths). `wrangler.jsonc`'s committed `vars`
  block currently sets it to `"false"` — deliberately, per Epic 7's own
  release note ("stories 7.5 to 7.7 are deployed together, with
  `AI_ENABLED = false` until 7.7 ships") and Story 7.7's own AC ("after the
  smoke test the owner flips `AI_ENABLED` to true"). Flipping the COMMITTED
  value to `"true"` (in `wrangler.jsonc`, before the next deploy that
  matters) is the owner's own action, after a real deploy and a real smoke
  test — not something any story in this build performs.
- **Where it lives:** Cloudflare dashboard → Workers & Pages → `8ish-plus` →
  Settings → Variables and Secrets (the plaintext Environment Variables
  section, not Secrets — `AI_ENABLED` is not sensitive).
- **How to flip it off (owner-executed, the fastest of the three
  kill-switch methods):**
  1. Cloudflare dashboard → Workers & Pages → `8ish-plus` → Settings →
     Variables and Secrets.
  2. Find `AI_ENABLED` under the plaintext variables list.
  3. Click Edit, change the value from `true` to `false`, then Save (and
     Deploy, if the dashboard prompts for it for a var-only change).
     Cloudflare characterizes a Worker var change as taking effect "within
     seconds" as new isolates pick it up — this code adds no further
     latency on top of that on its own fast path (zero KV calls).
  4. Confirm by making a request to `/api/transform` and confirming it
     answers `resting`.
- **How to undo:** repeat the same steps with the value set back to
  `"true"`.
- **Operator caution — a plain deploy silently reverts a dashboard-only flip
  back to whatever `wrangler.jsonc` currently commits, in EITHER direction:**
  `AI_ENABLED` is declared in `wrangler.jsonc`'s committed `vars` block, and
  Wrangler reconciles a Worker's `vars` to match that file on every
  `wrangler deploy`. Concretely, today (committed value `"false"`, pre-launch):
  a dashboard-only flip to `"true"` (e.g. for a smoke test) that isn't also
  committed to `wrangler.jsonc` will be silently reverted back to `"false"`
  by the next, otherwise-unrelated deploy — safe-by-default, but worth
  knowing so a smoke test doesn't get silently undone. Once the owner has
  committed `"true"` as the real launch default, the direction flips: a
  dashboard-only emergency disable (`"false"`) that isn't also committed
  will be silently reverted back to `"true"` by the next deploy — the
  scenario this caution was originally written for. Either way: for a
  disable that must survive a future deploy, also flip the committed value
  in `wrangler.jsonc` itself before that deploy goes out — or rely on the
  WAF backup rule (§1.2), which is entirely dashboard-side and unaffected by
  any Worker deploy.

### 1.4 Cloudflare KV — `cfg:governor` (Governor routine limits)

- **Status:** live today as code (Story 7-4) — `functions/lib/governor-config.js`
  reads and validates this key; `config/governor.json` is the committed
  default value. Nothing has been pushed to a real KV namespace from this
  session, and no caller reads the loaded config yet (Story 7.5's job).
- **Where it lives:** the `STATE_KV` KV namespace (the same binding
  `entitlement`/`config`/`transform` already use), key `cfg:governor`.
- **Commands (exact):**
  - Push the committed default config:
    ```
    npx wrangler kv key put cfg:governor --path config/governor.json --binding STATE_KV --remote
    ```
  - Read it back to confirm:
    ```
    npx wrangler kv key get cfg:governor --binding STATE_KV --remote
    ```
- **Shape:** every field `functions/lib/governor-config.js`'s
  `validateGovernorConfig` checks — `ceiling`, `reserveShare`, `freeSlices`,
  `minGapSec`, `freeGlobalGapSec`, `freeDaily`, `subscriberDaily`,
  `mintPerHour`, `aiEnabled` — must all be present and correctly typed, or
  the **whole** object is rejected and every governed request answers
  `resting` until it's fixed. There is no partial-credit path.
- **Propagation / staleness:** bounded to roughly 30s by two layers —
  `STATE_KV.get`'s own `cacheTtl:30` plus a 30s in-isolate cache inside
  `loadGovernorConfig` — but the `--remote` write itself is documented as
  needing up to 60s+ to fully propagate across Cloudflare's edge. This is
  meaningfully slower than the `AI_ENABLED` var flip (§1.3): for a genuine
  emergency, flip `AI_ENABLED` first; don't rely on a `cfg:governor` push as
  the fast lever.
- **How to change limits:** edit `config/governor.json`, commit it (per this
  repo's normal review process), then re-run the `put` command above against
  the updated file.
- **How to undo/verify:** `kv key get ... --remote` and confirm the JSON
  matches what was intended.

### 1.5 Turnstile — widget, site key, hostname allowlist

- **Status:** planned, Epic 5 (Story 5-1 spikes whether it works at all on
  the owner's iPad home-screen PWA before it is built; AD-16 gate).
- **Where it lives:** Cloudflare dashboard → Turnstile → the site's widget
  configuration (site key, secret key, allowed hostnames).
- **Shape (from AD-16, not yet created):** hostnames restricted to
  `8ish.app` / `www.8ish.app`; the Worker calls `siteverify` without
  `remoteip`, requiring `success`, `action` present and matching, and
  `hostname` equal to the `ORIGIN` var's host.
- **How to verify once built:** a real free-tier Image request without a
  device token should mint one only after a passed Turnstile check; a
  replayed or missing token should fail with `403 human_check_failed`.
- **How to undo:** rotate or delete the widget in the same dashboard screen
  (also see `TURNSTILE_SECRET` under Secrets, §2).

### 1.6 Stripe — webhook endpoint (events + pinned `api_version`)

- **Status:** mixed. The receiving code (`functions/api/stripe-webhook.js`)
  is live today and verifies signatures with `STRIPE_WEBHOOK_SECRET`
  (already a live secret, §2), and (Story 6-1) re-fetches the subscription
  fresh from Stripe on every event and writes its status through
  `lib/subStatus.js`'s asOf-ordering guard rather than trusting the event
  payload or its arrival order — but **no endpoint has been created for it
  in the Stripe dashboard yet** — that dashboard step is still open.
- **Where it lives:** Stripe dashboard → Developers → Webhooks → Add
  endpoint, URL `https://8ish.app/api/webhooks/stripe`.
- **Events to subscribe today (what the code actually handles, since
  Story 6-1):** `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`, and
  `checkout.session.completed`. Any other event type is acknowledged
  (`200`) without action, per Stripe's own requirement to ack unhandled
  types.
- **Pinned `api_version`:** when creating the endpoint, Stripe lets you pin
  the API version it sends events in. Set it to `2025-03-31.basil` — the
  same version `functions/lib/stripe.js`'s `STRIPE_API_VERSION` constant
  pins on every outgoing REST call (the one file allowed to hold that
  string, per Story 6-1/AD-17), and the version the code's own comments
  already assume (e.g. `current_period_end` living on the subscription
  item, not the subscription object). Moving to a newer Stripe API version
  is a deliberate, separately tested change — never a silent drift between
  the two.
- **How to verify:** in Stripe test mode, run `stripe trigger
  customer.subscription.updated` (or use `stripe listen`, §4) and confirm
  the endpoint shows a `200` response in the Stripe dashboard's webhook
  event log.
- **How to undo:** disable or delete the endpoint in the same dashboard
  screen; the app still works without it — `entitlement.js`'s live Stripe
  lookup (through `lib/subStatus.js`'s `read()`) is the fallback. Since
  Story 6-1, an `active: true` `subStatus:<id>` entry carries a 6-hour
  `expirationTtl` (`lib/subStatus.js`'s `write()`), so a subscription that
  goes inactive with no webhook to report it self-heals within 6 hours the
  next time anything reads its status — `entitlement.js`'s cache-miss falls
  back to a live lookup, which does not itself refresh the KV entry (only a
  webhook write does); an inactive entry carries no expiry, since there is
  nothing to self-heal from. That live-lookup fallback is itself backed by
  a separate, much shorter 60-second in-isolate lookup cache (also in
  `lib/subStatus.js`, isolate-lifetime only) that only dedupes repeated
  live Stripe calls within the same Worker isolate — it has nothing to do
  with the 6-hour KV self-heal above and is never a substitute for it.
  `monetize.js`'s 60-second `ENTITLEMENT_RECHECK_MS` only floors how often
  the *client* asks — the 6-hour figure above is what actually bounds how
  stale the *server's* cached answer can get without a webhook.

### 1.7 Stripe — renewal, cancellation, and failed-payment emails

- **Status:** live today as Stripe account defaults; not verified against
  this product's needs yet, and not epic-gated (it is an account setting,
  not a feature this repo builds).
- **Where it lives:** Stripe dashboard → Settings → Billing → Automatic
  emails (renewal reminders, failed-payment/dunning emails, and the
  subscription-cancelled confirmation email).
- **Why it matters here:** AD-17 assigns cancellation-on-failed-payment
  messaging entirely to these Stripe-managed emails — this repo sends none
  of its own. Story 6.6's `functions/api/subscription.js` (the in-app
  Cancel/Resume endpoint) is no exception: it calls Stripe to set or clear
  `cancel_at_period_end` and returns the result to the app, but never sends
  or triggers an email itself — whatever confirmation (or none) a family
  sees after tapping Cancel in the Parents Hub is entirely this same
  dashboard setting, same as every other Stripe-managed email above.
- **How to verify:** confirm both toggles are on, and that the sender
  address/branding match what a parent should recognize as legitimate (a
  cold "billing failed" email from an unrecognized sender is exactly what a
  phishing email looks like).
- **How to undo:** toggle off in the same settings screen.

### 1.8 Stripe — Terms URL in public business details

- **Status:** mixed. `functions/api/checkout.js` (Story 6-4) is live today:
  it verifies a Turnstile token before any Stripe call, then creates the
  Session with `billing_mode[type]=classic`,
  `consent_collection[terms_of_service]=required`, and
  `custom_text[terms_of_service_acceptance][message]` built from
  `public/legal.js`'s `WAIVER_CONSENT` in the caller's language. The Waiver
  wording itself is a **developer draft** (spec-6-4's Design Notes) — it is
  what a parent sees at checkout right now, but it is pending the owner's
  and Story 6.7's legal-review gate before this goes live for real money;
  `scripts/check-shared.mjs` only proves the two languages exist and stay
  under Stripe's 1200-character limit, not that the wording itself is
  legally sound. **Not yet done:** the Terms URL itself, below, is still a
  dashboard-only setting nothing in this repo can set.
- **Where it lives:** Stripe dashboard → Settings → Business → Public
  details → Terms of Service link.
- **How to verify:** open a test-mode Checkout Session and confirm the
  consent checkbox links to the live `terms.html` page, not a placeholder,
  and that the checkbox's own text matches `public/legal.js`'s
  `WAIVER_CONSENT` for the session's `locale`.
- **How to undo:** clear or replace the URL in the same settings screen.
- **Also still open (owner action item, not reachable from this repo):**
  the two new Stripe Prices themselves (yearly 99 RON, monthly 14.99 RON)
  have not been created yet — `wrangler.jsonc`'s `STRIPE_PRICE_MONTHLY`/
  `STRIPE_PRICE_YEARLY` vars still point at whatever Price ids were set
  before this story, in both Stripe test and live mode. Creating the two
  Prices in the Stripe dashboard and updating those two vars' values is the
  owner's job, not this story's (see the spec's own "Always" boundary) —
  until it happens, checkout.js keeps selling at the old prices. The real
  Workers-bundler import of `public/legal.js` from `checkout.js` (confirm
  `wrangler dev` loads it without an import error — see the Code Map note
  on `public/legal.js` importability) is a separate, still-open owner check
  against a real deploy. **Release order (Story 6-7):** `terms.html` and
  `privacy.html` are deployed with the accurate legal wording *before* the
  two new Prices above are switched on — do not flip
  `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_YEARLY` to the new Price ids until
  the legal-pages deploy is confirmed live.

### 1.9 Stripe — complimentary family promo code

- **Status:** planned, Epic 9 (Story 9-1, "the family gets a free
  subscription"). Depends on §1.8's still-open action item above — a
  complimentary-code redemption still goes through `checkout.js`'s own
  `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_YEARLY` Price selection, so the two
  new Prices must exist and be set before this can be verified.
- **Where it lives:** Stripe dashboard → Product catalog → Coupons →
  create a coupon (`duration: forever`, 100% off), then Promotion codes →
  create a code from it.
- **Shape (from AD-17, not yet created):** `max_redemptions: 1`, restricted
  to the family's own Stripe customer, kept secret (never committed, never
  put in this file); Checkout for it uses
  `payment_method_collection: if_required` so no card is required for a
  0-total session.
- **How to verify:** redeem it once in test mode and confirm
  `checkout/confirm` accepts the resulting session and issues a working
  credential (AD-15 calls this out explicitly as needing a test-mode check,
  since a 100%-off session's reported status is not yet confirmed).
- **How to undo:** deactivate the promotion code (Stripe keeps redemption
  history even when deactivated) or delete the coupon.
- **How to recreate:** if the code is ever lost, deactivated by mistake,
  or a second family device needs a fresh redemption path, repeat "Where
  it lives" above with a new coupon + promotion code (still
  `max_redemptions: 1`, still restricted to the family's own customer) --
  there is nothing else to rebuild, since the checkout/restore code path
  itself is the same one every ordinary subscriber already uses and needs
  no family-specific change.
- **Code-side audit (Story 9-1, confirmed already built, no new code
  needed):** `functions/api/checkout.js` already sends
  `allow_promotion_codes: "true"` and
  `payment_method_collection: "if_required"` on every Checkout session
  (`scripts/check-config.mjs`'s "checkout.js: a valid session carries...
  payment_method_collection=if_required, allow_promotion_codes..." check);
  `functions/api/stripe-webhook.js` never counts a 0 RON
  `checkout.session.completed` as a `purchase_completed` sale
  (`amount_total > 0` gate, "checkout.session.completed with
  amount_total: 0 writes NO purchase_completed" check); the restore flow
  (Story 6-3/6-4) is unmodified and family-agnostic. Verified by running
  the full check suite (`node scripts/run-checks.mjs`) with zero new
  checks needed.

### 1.10 Cloudflare Analytics Engine — read token

- **Status:** built, awaiting the owner's token creation (Story 8-4). The
  daily rollup Cron Trigger (`worker.js`'s `scheduled()`, `0 3 * * *` UTC —
  see `wrangler.jsonc`'s `triggers.crons`) and `functions/lib/rollup.js`'s
  `buildRollup()` are code-complete and unit-tested
  (`test/rollup.test.mjs`) against mocks. Neither `ANALYTICS_READ_TOKEN`
  nor `CF_ACCOUNT_ID` exists anywhere in this build's own session — both
  are genuinely absent secrets the owner must create/set — so `scheduled()`
  degrades to "logs `rollup_build_failed`, writes nothing" every night
  until both are set, exactly like any other source failure this story
  defines. No live run has happened yet (see
  `_bmad-output/implementation-artifacts/deferred-work.md`'s Story 8-4
  entry).
- **Where it lives:** Cloudflare dashboard → My Profile → API Tokens →
  Create Token, scoped to **Account Analytics: Read** only.
- **Restricted scope:** account-wide analytics read — broader than a single
  dataset, so AD-9 calls out treating it with the same care as a secret of
  that blast radius even though it grants no write or billing access.
- **How to verify once built:** after `wrangler secret put ANALYTICS_READ_TOKEN`
  and setting `CF_ACCOUNT_ID` (a plain var, not a secret — Cloudflare
  account ids aren't sensitive), the daily rollup Cron Trigger
  (`worker.js`'s `scheduled()`) should successfully read the previous UTC
  day's `FUNNEL` data via the Analytics Engine SQL REST API and write
  `rollup:<date>` to `STATE_KV`. Confirm via the dashboard's KV browser or
  `wrangler kv key get "rollup:<date>" --binding STATE_KV` (not run by this
  build — a real deploy is a prerequisite).
- **How to backfill missing days:** `node scripts/backfill-rollup.mjs <from
  YYYY-MM-DD> <to YYYY-MM-DD>` reruns the same `buildRollup()` logic once
  per date in an inclusive range, for recreating rollups still within
  Analytics Engine's 3-month retention window. It needs `CF_ACCOUNT_ID`,
  `ANALYTICS_READ_TOKEN`, and a separate **write**-scoped
  `CF_KV_WRITE_TOKEN` (Workers KV Storage: Edit) as env vars — none of
  which exist in this build's session either. **Known limitation:** even
  with all three set, the script's Governor-side (`gov`) read cannot
  succeed yet — Durable Objects have no public REST API reachable from a
  standalone Node process (only from inside a Worker via its own binding),
  so `scripts/backfill-rollup.mjs` today always skips every day it's given
  until a follow-up story adds a real path to the Governor RPC from
  outside a Worker. See that script's own header comment and
  `deferred-work.md`'s Story 8-4 entry.
- **How to undo / rotate:** revoke the token in the same dashboard screen,
  create a new one, `wrangler secret put ANALYTICS_READ_TOKEN` with the new
  value (see §2).

### 1.11 ⚠ Pending legal review — blocks the Epic 9 go/no-go

- **Status:** OPEN. Blocks Epic 9's go/no-go decision (A-5) until cleared —
  do not proceed with Epic 9's promotion checklist, or promote the app on
  the channel, while this flag is set.
- **What's pending:** `public/legal.js`'s `WAIVER_CONSENT` (Story 6-4) and
  `REFUND_POLICY` (Story 6-7) are both **developer drafts** — plain-language
  wording written by the developer, not a lawyer. `terms.html` (both `ro`
  and `en`) renders both of them verbatim at load time, so whatever change a
  review produces in `legal.js` automatically reaches `terms.html` and the
  Stripe Checkout consent text, with no separate edit needed anywhere else.
- **What clears it:** the owner sends `WAIVER_CONSENT` and `REFUND_POLICY`
  (both languages) to a lawyer or the consumer-protection authority (ANPC,
  for a Romania-governed contract), records the outcome here, and applies
  any resulting wording change to `public/legal.js`. Once the review is
  done and any changes are applied, replace this bullet with the date, who
  reviewed it, and a one-line summary of the outcome, then remove the ⚠
  from this section's heading.
- **Never:** claim this review has happened until it actually has — this
  flag exists specifically so nobody treats the go/no-go as clear, or
  promotes the app, while the wording is still an unreviewed developer
  draft.

### 1.12 Stripe — monthly dispute-rate check, and "a refund means cancel immediately"

- **Status:** live today as an owner routine once the app is selling for
  real; not code-enforced (there is nothing in `functions/` to check here —
  disputes and refunds happen entirely in the Stripe dashboard).
- **Monthly dispute-rate check:**
  - **Where:** Stripe dashboard → Payments → Disputes (or the "Radar" /
    disputes overview, depending on the Stripe dashboard version) → filter
    to the last calendar month.
  - **How to check:** divide that month's dispute count by that month's
    total successful charge count. **If the dispute rate is above 0.5%,
    trigger a policy review** — re-read `REFUND_POLICY` and `WAIVER_CONSENT`
    against the disputes' actual stated reasons (Stripe shows a reason code
    per dispute, e.g. "product not received", "subscription cancelled") and
    consider whether the refund/cancellation wording or process needs to
    change, or whether disputes are concentrated around one specific
    failure (e.g. `/api/transform` errors) that should be fixed directly
    instead.
  - **Why 0.5%:** Stripe (and card networks) treat a dispute rate above
    roughly this range as a risk signal that can affect the account's
    standing; catching it monthly, before it accumulates, is cheaper than
    reacting after Stripe flags the account.
- **"A refund means cancel immediately" rule:** when the owner processes a
  refund under the Terms' fix-or-refund guarantee (`REFUND_POLICY`), the
  same action must also **cancel the subscription immediately** in the
  Stripe dashboard — never just refund the charge and leave the
  subscription active to keep renewing.
  - **How:** Stripe dashboard → Customers → the customer → the subscription
    → Cancel subscription → choose **immediately** (not "at period end") —
    this is a different action from Story 6.6's in-app Cancel, which always
    cancels `at_period_end`; a refund is the one case where an immediate,
    owner-initiated cancellation is correct, since the family should not
    keep paying-and-being-refunded on a loop.
  - Then, separately, issue the refund itself: Payments → the charge →
    Refund, for the amount agreed under `REFUND_POLICY`.
  - **Order doesn't matter functionally** (cancel-then-refund and
    refund-then-cancel both leave the subscription cancelled and the charge
    refunded), but do both in the same sitting — an owner who refunds and
    means to cancel "later" is exactly the gap this rule exists to close.

---

## 2. Secrets

Every secret is set with `wrangler secret put <NAME>` (never committed,
never placed in `wrangler.jsonc`'s `vars`). This section gives the shape and
rotation steps only — no real secret value belongs here or anywhere in the
repo.

### 2.1 `STRIPE_SECRET_KEY` — live today

- **Read by:** `functions/api/checkout.js`, `checkout-confirm.js`,
  `entitlement.js`, `restore.js`.
- **Restricted scope:** a **restricted** Stripe API key (not the account's
  full secret key) limited to Checkout Sessions, Subscriptions and
  Customers only — create it as a restricted key in the Stripe dashboard,
  not the default full-access secret key.
- **Rotation steps:**
  1. In the Stripe dashboard, create a new restricted key with the same
     scopes (live mode keeps the old key active during this).
  2. `wrangler secret put STRIPE_SECRET_KEY` with the new value.
  3. Verify a real checkout completes end to end (test mode first, then a
     single live-mode smoke test if this is a live rotation).
  4. Revoke the old key in the Stripe dashboard only after step 3 passes.
- **Undo:** if the new key breaks something before the old one is revoked,
  `wrangler secret put STRIPE_SECRET_KEY` with the old value again.

### 2.2 `STRIPE_WEBHOOK_SECRET` — live today

- **Read by:** `functions/api/stripe-webhook.js` (HMAC-SHA256 signature
  verification of the raw request body, per Stripe's documented manual
  verification algorithm — no Stripe SDK in this repo).
- **Restricted scope:** not an API-access credential — it only verifies
  that a webhook payload actually came from Stripe. No API scope to set.
- **Rotation steps:**
  1. In the Stripe dashboard, on the webhook endpoint (§1.6), use "Roll
     secret" — Stripe keeps the old signing secret valid for a short
     overlap window while the new one is generated.
  2. `wrangler secret put STRIPE_WEBHOOK_SECRET` with the new value.
  3. Trigger a test event (`stripe trigger customer.subscription.updated`
     in test mode, or wait for a live event) and confirm `wrangler tail`
     shows no `webhook_signature_verify_failed` for it.
  4. Let the old secret's overlap window expire naturally (Stripe retires
     it on its own; there is no separate "revoke" step here).
- **Undo:** `wrangler secret put STRIPE_WEBHOOK_SECRET` with the previous
  value, while it is still inside Stripe's overlap window.

### 2.3 `ENTITLEMENT_SECRET` (+ `_PREV`) — live today

- **Status:** live in code since Story 6-2. `functions/lib/credential.js`
  is the one file that mints (`c1.<payload>.<hmac>`) and verifies with it;
  `functions/api/checkout-confirm.js` and `functions/api/restore.js` both
  mint through it on a successful confirm/restore. Not yet set in the real
  Cloudflare dashboard (`wrangler secret put`) — until it is, both
  endpoints answer `not_configured` and mint nothing (fails closed).
- **Shape (AD-15):** HMAC-signs the `c1.<payload>.<hmac>` Entitlement
  Credential, `{sub, iat, exp, v}`, 7-day expiry. (The `d1.<id>.<hmac>`
  device token, AD-16's other half, is still planned, Epic 7.)
- **Restricted scope:** a symmetric signing key held only by the Worker; no
  external API scope, but its blast radius on leak is high (anyone with it
  can mint a valid credential) — treat rotation as urgent if ever exposed.
- **Rotation steps (once built), per AD-15's own `_PREV` design:**
  1. Move the current `ENTITLEMENT_SECRET` value to
     `wrangler secret put ENTITLEMENT_SECRET_PREV`.
  2. `wrangler secret put ENTITLEMENT_SECRET` with a newly generated value.
     Verification checks both `ENTITLEMENT_SECRET` and `_PREV`, so
     credentials signed under the old key keep verifying during the
     overlap.
  3. Wait at least 7 days (the credential's own `exp`) so every credential
     signed under the old key has expired and been re-minted.
  4. Remove `ENTITLEMENT_SECRET_PREV` (`wrangler secret delete`).
- **Undo:** during the overlap window, `wrangler secret put
  ENTITLEMENT_SECRET` with the previous value restores it immediately.

### 2.4 `TURNSTILE_SECRET` — code live since Story 6-3, unusable until Story 5-1

- **Status:** `functions/lib/turnstile.js` (Story 6-3) calls `siteverify`
  with it whenever the secret is set, but nothing sets it: the Turnstile
  widget itself (§1.5) is still blocked on Story 5-1's real-device spike.
  Until then `restore.js` always answers `403 human_check_failed` for
  every request, by design (fail closed, not insecure) — not a bug.
- **Troubleshooting:** a missing `TURNSTILE_SECRET` folds into the same
  generic `human_check_failed` a real failed check gives — no distinct
  `not_configured` signal, unlike `STRIPE_SECRET_KEY`/`ENTITLEMENT_SECRET`
  (deliberate: not telling a caller whether Turnstile is configured at
  all). If restore or checkout (Story 6-4) is failing for *every* attempt
  including a genuinely passed check, confirm this secret (and `ORIGIN`,
  and `TURNSTILE_SITE_KEY` client-side) are actually set before assuming
  an attack. `ORIGIN` unset also independently fails `checkout.js` closed
  with `not_configured` (its success/cancel URLs come only from `ORIGIN`,
  never the request — AD-9/AD-17), so both endpoints stay unusable until
  it's set, same as Turnstile already required.
- **Restricted scope:** paired one-to-one with the Turnstile site key/widget
  it verifies; no broader API scope.
- **Rotation steps (once built):** rotate the secret key in the Turnstile
  dashboard (§1.5), then `wrangler secret put TURNSTILE_SECRET` with the
  new value; the old secret stops verifying the moment it is rotated in the
  dashboard, so do this promptly after generating the new one to avoid a
  gap where real human checks fail.
- **Undo:** re-generate the previous secret is not possible in Turnstile
  (rotation is one-directional) — if a rotation breaks something, roll
  forward with a fresh secret rather than trying to restore the old one.

### 2.5 `ANALYTICS_READ_TOKEN` — built, awaiting the owner's token creation (Story 8-4)

- See §1.10 for the token's scope, rotation steps, and the daily rollup/
  backfill mechanics that consume it (kept together with its dashboard
  entry since the token itself is entirely a Cloudflare API token with no
  separate Worker-side shape).
- `CF_ACCOUNT_ID` (a plain `wrangler.jsonc` var, not a secret — see that
  file's own comment on this key) must also be set to the owner's real
  Cloudflare account id for the daily rollup to do anything; committed as
  `""` by this build.
- `scripts/backfill-rollup.mjs` additionally needs its own
  write-scoped `CF_KV_WRITE_TOKEN` (Workers KV Storage: Edit) as a plain
  env var at invocation time (never a Worker secret, never committed) — see
  §1.10's "How to backfill" note for why this is a separate token from
  `ANALYTICS_READ_TOKEN` and this script's own current Governor-RPC
  limitation.
- `scripts/readout.mjs` (Story 8.6, §13) needs its own **read**-scoped
  `CF_KV_READ_TOKEN` (Workers KV Storage: Read) as a plain env var at
  invocation time — deliberately a third, separate token from both
  `ANALYTICS_READ_TOKEN` (a different Cloudflare product/scope: Account
  Analytics Read, not KV) and `CF_KV_WRITE_TOKEN` (this script never writes,
  so it must never be handed a write-capable credential). None of these
  three exist in this build's session.

---

## 3. Cutover checklist (AD-9)

The five-step cutover order, from architecture AD-9. Each step is recorded
here as it happens; do not mark a step done until it actually is.

- [x] **1. Restructure `wrangler.jsonc`.** Done — Story 4.2. Single
      production Worker `8ish-plus` declared at the top level, no `env`
      blocks, so no binding can be silently dropped.
- [x] **2. Repoint the deploy pipeline — this repo's side.** Done — Story
      4.4. `package.json` pins `wrangler` and defines `npm run check`,
      which is the exact Build command a Workers Builds project should run.
      **Not done:** the owner's actual dashboard action — reconnecting
      Workers Builds to `8ish-plus` with a fresh least-privilege build
      token, and disabling the old `8ishqa` connection so it cannot
      redeploy the retiring Worker. Tracked in `sprint-status.yaml`'s open
      action items for Epic 4.
- [ ] **3. Give the family a complimentary subscription.** Code-ready,
      not yet redeemed (Story 9-1). The checkout-to-credential path (Epic
      6/7) is complete and already carries every guarantee this needs:
      `checkout.js` sends `allow_promotion_codes: "true"` and
      `payment_method_collection: "if_required"` (proven by
      `scripts/check-config.mjs`'s "checkout.js: a valid session carries...
      payment_method_collection=if_required, allow_promotion_codes..."
      check), and `stripe-webhook.js` never counts a 0 RON session as a
      sale (`amount_total > 0` gate, proven by "checkout.session.completed
      with amount_total: 0 writes NO purchase_completed"). What's left is
      purely the owner's own Stripe-dashboard action: create the coupon
      and promotion code per §1.9 below, then redeem it once (test mode
      first, per AD-15's own note that a 100%-off session's reported
      status needs a test-mode check).
- [ ] **4. Delete the `8ishqa` Worker.** Not started. Reason: must not
      happen before step 3 is confirmed working on the family's own
      devices — `8ishqa` is their only working link until then (Story
      9-2 explicitly gates this on 9-1).
- [ ] **5. Remove `PLAN_MODE` and `planMode`.** Not started. Reason:
      depends on step 4 and the Epic 9 promotion checklist / go-no-go
      gate (Stories 9-3 to 9-5) — removing the free/unlimited mode
      distinction before the paid path and its abuse checks are verified
      live would leave no fallback.

---

## 4. Local and test setup

- **Stripe:** use Stripe **test mode** keys locally (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET` from a test-mode webhook endpoint, or from the
  Stripe CLI). Run `stripe listen --forward-to
  http://localhost:8787/api/webhooks/stripe` (adjust the port to whatever
  `wrangler dev` uses) to get a locally-scoped webhook signing secret and
  have Stripe CLI forward real test events to it; `stripe trigger
  customer.subscription.updated` fires one on demand.
- **Turnstile:** once built (Epic 5), use Cloudflare's documented dummy
  Turnstile site/secret key pairs for test mode (always-passes and
  always-blocks variants) instead of the real widget, so local runs don't
  depend on a live Turnstile check.
- **`AI_STUB` (dev only):** planned alongside the Governor work (Epic 7).
  `wrangler dev` calls the **real, billed** Workers AI today — there is no
  local stub yet. Once `AI_STUB` exists, setting it in `.dev.vars` locally
  will make the transform handler return a canned response instead of
  calling `env.AI.run()`, which the abuse-check scripts (Story 7-9) require
  so they can run repeatedly without racking up real AI cost.
- **Running locally today:** `npx wrangler dev` serves `public/` and
  `functions/` together, matching production routing, but every `/api/transform`
  call it makes is a real, billed Workers AI call — be deliberate about how
  many test transforms you run locally until `AI_STUB` exists.

---

## 5. Rollback

- **Code and config:** `npx wrangler rollback [deployment-id]` reverts the
  Worker to a previous deployment (list candidates with `npx wrangler
  deployments list`). This is the fast path for a bad deploy.
- **What rollback does NOT undo:**
  - **Durable Object migrations.** Per AD-9, migrations are additive
    only for exactly this reason — `wrangler rollback` cannot remove a
    migration once applied, so a rolled-back Worker running older code
    against a newer DO schema must still work, or the migration was not
    actually additive. As of Story 7-2, the `Governor` Durable Object
    (SQLite storage, `new_sqlite_classes` migration tag `v1`) is that first
    migration this note has been waiting for — any future migration
    touching `Governor` must stay additive the same way.
  - **KV writes.** Any `subStatus:<id>`, `cfg:governor`, `state:<budgetDay>`
    or `rollup:<date>` key written by the newer code stays written; rolling
    back the Worker code does not roll back KV data.
  - **Secrets.** Rolling back the Worker does not change secret values —
    secrets are rotated independently (§2), not tied to a deployment.
- **When to roll back vs. fix forward:** for a broken deploy with no data
  migration involved, roll back immediately, then fix and redeploy. For
  anything touching the Governor's schema once it exists, fixing forward is
  usually safer than rolling back to code that no longer matches the
  DO's actual schema.

---

## 6. If the bill spikes

**Today's reality (updated for Story 7-4):** the Governor's config-loading
code (`functions/lib/governor-config.js`, the `AI_ENABLED` var, §1.3/§1.4)
is live **as code**, but nothing calls it yet — `functions/api/transform.js`,
the real production `/api/transform` endpoint, still only has the old
single global 90-second cooldown between AI calls (`COOLDOWN_MS`, backed by
`STATE_KV`) and does not consult `AI_ENABLED` or `cfg:governor` at all. **Do
not assume flipping `AI_ENABLED` stops real spend yet** — it has zero effect
on live traffic until Story 7.5 wires the endpoint to check it. Until then,
the steps below (WAF-rule-first) are still the real emergency procedure;
this section gets its own update once Story 7.5 ships and the var actually
gates the endpoint.

**First response, today:**

1. **Confirm it's real spend, not a false alarm.** Check the Cloudflare
   dashboard → Workers & Pages → `8ish-plus` → Metrics, and Workers AI
   usage under Account → AI, for the current UTC day's request volume and
   neuron usage.
2. **Stop new AI spend immediately.** Flipping `AI_ENABLED` today does
   **nothing** to real traffic (see above — no caller reads it yet). The
   only dashboard-only lever that actually works today is a Cloudflare WAF
   custom rule blocking `/api/transform` (the same shape as the pre-made
   backup switch, §1.2) — create and enable it directly; this does not
   require any code change or deploy, and works regardless of what the
   application code does.
3. **Rule out a compromised or leaked key.** If the spend pattern looks
   like automated abuse rather than organic traffic, check whether
   `STRIPE_SECRET_KEY` shows unexpected API activity in the Stripe
   dashboard's own logs (a separate concern from AI cost, but worth ruling
   out at the same time) — rotate it (§2.1) if anything looks wrong.
4. **Once stopped, investigate before re-enabling:** review Workers AI
   usage graphs for the spike's time window and request pattern; there is
   no per-request audit trail today beyond the sanitized event-code logs
   (§7) and Cloudflare's own request metrics, since invocation logs are
   deliberately off.
5. **Re-enable** by disabling the WAF rule from step 2 once the cause is
   understood and addressed.

**Once Story 7.5 ships (the endpoint actually checks `AI_ENABLED`/`cfg:governor`):**
step 2 becomes "flip the `AI_ENABLED` Worker var to `false` in the
Cloudflare dashboard (Settings → Variables and Secrets) — takes effect
within seconds, no deploy needed" as the *primary*, fastest lever; the WAF
rule becomes the *backup* if the var somehow doesn't take effect, per §1.2's
own three-layer design. `scripts/readout.mjs` (Story 8.6, §13) becomes the
first place to look in step 1 instead of the raw dashboard metrics, since it
reports the Governor's own gauge and a 15-minute failure-rate window
purpose-built for spike detection.

---

## 7. Story 4.3's logging audit

Story 4.3 ("Logs carry no personal data") audited every `console.*` call
site in `functions/` and `worker.js`. Result, recorded here as the
authoritative record of that audit:

- **12 sites, across 6 files**, each replaced to log a fixed, short event
  code (optionally followed by a plain HTTP status number already in
  scope) instead of a raw error object, `.message`, `.stack`, an email, a
  Stripe/customer/subscription/session id, an IP, a token, a URL, or an
  upstream response body. `worker.js` had no `console.*` call at the time
  of the audit. (Story 6-1 later extended the same rule to a 13th site,
  `webhook_funnel_write_failed`, and swapped `entitlement.js`'s two
  cache-specific codes below for two Stripe-lookup-specific ones — the
  underlying rule and its structural check are unchanged.)
- The event codes are: `restore_code_store_failed`,
  `restore_code_ensure_failed`, `checkout_session_create_failed`,
  `entitlement_stripe_error`, `entitlement_lookup_failed`,
  `restore_cooldown_read_failed`, `restore_cooldown_write_failed`,
  `webhook_signature_verify_failed`, `webhook_processing_failed`,
  `webhook_funnel_write_failed`, `cooldown_write_failed`,
  `cooldown_read_failed`, `transform_error`.
  (These are internal debug codes only — a separate concern from AD-19's
  Analytics Engine event allowlist, e.g. `app_open`, `purchase_completed`.)
- `wrangler.jsonc`'s `observability` block was set to
  `enabled: true` with `logs.invocation_logs: false` — Cloudflare's
  automatic per-request invocation log (which otherwise records the full
  request, response and metadata, including the URL) is off, while this
  app's own event-code `console.*` output keeps flowing to `wrangler tail`
  and the dashboard.
- A structural check (`scripts/check-config.mjs`) was added that fails the
  build if `observability.logs.invocation_logs` is not `false`, or if any
  of the six files' `console.*` calls reintroduces a raw response body
  (`.text()`, `.json()`) or a bare caught-error identifier as an argument.
- **Still open (owner, not reachable from this repo):** verify with a real
  test-mode deploy — trigger a failed Stripe test-mode call and read
  `wrangler tail`; it should show only the event code and an HTTP status,
  never a query string, email, subscription id or session id. Tracked as
  an Epic 4 action item in `sprint-status.yaml`.

---

## 8. Where the open owner actions live

This file records the shape of each dashboard item and secret; it does not
duplicate the list of what's currently outstanding for the owner to actually
go do. That list is `sprint-status.yaml`'s `action_items`
(`_bmad-output/implementation-artifacts/sprint-status.yaml`) — check there
for the current, single source of truth on what's open, in progress or
done, rather than treating any "status" note above as current once time has
passed.

---

## 9. Kill Switch drill (Story 7-4/AD-14, owner-executed against a real deployment)

**⚠ This is a template, not a recorded run.** Nothing in this section has
been performed in this build session — there is no live deployment to time
against, and this story explicitly does not touch a real Cloudflare
dashboard or run any `wrangler` command. Once `/api/transform` is actually
wired to the Governor (Story 7.5 onward, deployed with the endpoint live),
the owner runs this checklist for real, fills in the timing table below (or
a copy of it), and keeps the completed copy here as the dated record —
matching Story 7-9's own "a run is recorded in the runbook with date +
commit" convention for the abuse-check script.

**Goal:** confirm each of the epic's three independent kill-switch/config
layers (AD-14) actually brings the app to "resting" for real traffic, and
that each does so well inside the epic's 5-minute target.

**Before starting:** note the exact UTC time and the current deployed
commit hash (`npx wrangler deployments list` or the Cloudflare dashboard's
Deployments tab) — both go in the record at the end.

**Method A — `AI_ENABLED` Worker var flip (§1.3, expected: fastest):**

1. Start the timer. Note the start time.
2. Flip `AI_ENABLED` to `false` per §1.3's steps.
3. Send one real request to the live `/api/transform` endpoint (or whatever
   client action triggers it) and confirm it answers the friendly "resting"
   state, not a normal success.
4. Stop the timer the moment step 3's response is confirmed. Record the
   elapsed time.
5. Flip `AI_ENABLED` back to `"true"` per §1.3, confirm normal Image
   requests succeed again, then continue to Method B.

**Method B — `cfg:governor` KV push (§1.4, expected: slower, ~30–90s):**

1. Start the timer.
2. Push a copy of `config/governor.json` with `aiEnabled: false` (or
   `ceiling: 0`) using the `kv key put` command in §1.4.
3. Poll the live endpoint every ~10s until it answers "resting" (the cache
   + propagation bound means this may take up to roughly 60–90s, not
   instant — that gap is the whole reason Method A exists as the primary
   lever, not this one).
4. Stop the timer once "resting" is confirmed. Record the elapsed time.
5. Push the real `config/governor.json` (with `aiEnabled: true`) back,
   confirm normal requests succeed again, then continue to Method C.

**Method C — WAF custom rule enable (§1.2, expected: near-instant, edge-level):**

1. Start the timer.
2. Enable the pre-made, disabled WAF rule per §1.2's "How to enable" steps.
3. Send one request to `/api/transform` and confirm it gets Cloudflare's
   own block response (visible in the WAF rule's Security Events log).
4. Stop the timer once the block is confirmed. Record the elapsed time.
5. Disable the rule again per §1.2, confirm normal requests succeed again.

**Record the results here (copy this table for each dated drill run):**

| Date (UTC) | Deployed commit | Method A time | Method B time | Method C time | All ≤ 5 min? | Notes |
|---|---|---|---|---|---|---|
| _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ | _(fill in)_ |

**If any method exceeds 5 minutes or fails to reach "resting" at all:**
treat that as a finding against this story's own design, not just an
operator error — record what happened, and revisit whichever of
`functions/lib/governor-config.js`'s caching/propagation assumptions (or the
WAF rule's own configuration) the timing points to before relying on that
method during a real incident.

---

## 10. Abuse-check script (Story 7-9/AD-14/AD-22/AD-23)

`scripts/abuse-check.mjs` is the closing proof for Epic 7: it `import`s the
REAL, unmodified `functions/api/transform.js` and calls its `onRequestPost`
exactly as `worker.js` would, wired to a REAL Governor
(`functions/lib/governor-do.js`'s `createGovernorHandlers` over a real
`node:sqlite`-backed adapter — the same technique `test/governor-*.test.mjs`
already use) behind a Durable-Object-shaped stub, with `env.AI`/Stripe/
Turnstile mocked or stubbed. It proves the 9 abuse/cost-safety scenarios
epics.md's own Story 7.9 lists, end-to-end, through the real production
request path — not a reimplementation. See that script's own header comment
for the full harness architecture, and `_bmad-output/implementation-artifacts/spec-7-9-abuse-checks.md`
for the frozen intent this proves.

### 10.1 Local mode (no deployment, no secrets needed)

```
node scripts/abuse-check.mjs
```

Runs all 9 scenarios against an in-process, real `node:sqlite`-backed
Governor. Costs nothing, needs no real Cloudflare/Stripe/Turnstile
credentials, and never touches a live deployment. Prints one `✔`/`✗` line
per scenario plus a summary; exits `0` only if every scenario passed.

### 10.2 Post-deploy mode (requires a real deployment + Cloudflare API token)

```
CF_API_TOKEN=<a Cloudflare API token with Workers Scripts:Read> \
CF_ACCOUNT_ID=<the Cloudflare account id> \
node scripts/abuse-check.mjs --post-deploy https://8ish.app
```

Runs three additional checks against a REAL deployed URL (never invoked
during the Story 7-9 build session — there was no live deployment to point
it at): (a) a real burst of requests above the WAF rate-limit rule (§1.1, 6
req/10s/IP) gets a `429` from Cloudflare's own edge; (b) the
`*.workers.dev` address for this Worker does not answer at all
(`workers_dev:false` in `wrangler.jsonc`); (c) via the Cloudflare API
(`GET /accounts/:id/workers/scripts` + per-script binding inspection), no
OTHER Worker on the account holds the `AI` binding. Both `CF_API_TOKEN` and
`CF_ACCOUNT_ID` are required — the script prints a clear error and exits
non-zero if invoked without them.

### 10.3 Recording a run

Per epics.md's own Story 7.9 acceptance criteria: **a run is recorded here
with the date and the commit, and a failing scenario blocks the Epic 9
go/no-go.** Copy the table below for each dated run (local mode, post-deploy
mode, or both) and fill it in — this template is intentionally blank; no
real run has happened yet as of this story's own build.

| Date (UTC) | Commit | Mode | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | Post-deploy (a/b/c) | Overall | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| _(fill in)_ | _(fill in)_ | _(local / post-deploy)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail)_ | _(pass/fail/n-a)_ | _(pass/fail)_ | _(fill in)_ |

**If any scenario fails:** treat it as a genuine finding against the
underlying Stories 7.1–7.8 production code (this script only imports and
calls that code, unmodified) — do not edit the recorded run to hide a
failure, and do not proceed to Epic 9's go/no-go until the underlying cause
is understood and fixed.

---

## 11. Source Links (Story 8-3) — which video/bio link brought a visitor

**Status:** live today as code. `worker.js` reads the `SOURCE_LINKS` var
(`functions/lib/source-links.js`'s `parseSourceLinks`/`handleSourceLinkRequest`)
and answers `GET /<name>` — for a `name` in that list — with one
`writeEvent(env, ctx, "source_visit", name)` funnel counter
(`functions/lib/events.js`, Story 8-1, unchanged) and a `302` to exactly `/`.
Any other name (or a `HEAD`/non-`GET` request) is unaffected — it falls
through to the existing `404`, and nothing is written. Committed today as
`SOURCE_LINKS: ""` (empty) — no real channel/video name has been added by
any build; that's this section's own job, below.

**Where it lives:** `wrangler.jsonc`'s `vars.SOURCE_LINKS` — a plaintext
Worker var (not a secret), edited directly in the committed file, same as
every other var in that block.

**How to add a new Source Link (owner-executed):**

1. Pick a short name for the channel/video: lowercase letters, digits and
   `-` only, 2–20 characters (`^[a-z0-9-]{2,20}$`) — e.g. `yt` for a YouTube
   description link, or `ig-story1` for a specific Instagram Story.
2. Confirm it isn't already a real top-level file/folder under `public/`
   (e.g. `app`, `sw`, `fonts`, `icons`, `manifest`…) and isn't the reserved
   name `api` or `sw` — `scripts/check-config.mjs` (run as part of `npm run
   check`) fails the build if it collides, so this step is a courtesy, not
   the only line of defense.
3. Edit `wrangler.jsonc`'s `vars.SOURCE_LINKS`: a comma-separated list, e.g.
   `"yt"` for one name, or `"yt,ig-story1"` for two. No spaces are required
   around the commas (they're trimmed), but keep it readable.
4. Run `npm run check` (or `node scripts/check-config.mjs` alone) and
   confirm it passes — this is what actually validates the regex and the
   collision check above before anything ships.
5. Deploy (per this repo's normal deploy process — this file doesn't itself
   run `wrangler`).
6. Put the real link — `https://8ish.app/<name>` (or `https://www.8ish.app/<name>`)
   — in the video description/bio/wherever it's meant to go.

**How to verify:** visit `https://8ish.app/<name>` directly; it should land
on the app's home screen (`/`) same as visiting the site directly — the
redirect carries no visible query string, cookie, or marker of any kind (by
design; see the Story 8-3 spec's Boundaries — no per-visit data is ever
stored, only the aggregate `source_visit` counter). Reading the actual visit
counts is `scripts/readout.mjs`'s job (Story 8.6, §13 below) — the same
daily rollup every other funnel event goes through; there is no separate
Source-Links-only report.

**How to remove/retire one:** delete its name from the `SOURCE_LINKS` list in
`wrangler.jsonc` and deploy — the old link then answers the plain `404` any
unrecognized path gets. Nothing about a retired name is ever cleaned up
elsewhere (there's nothing to clean up — no per-name state is stored
anywhere but the aggregate Analytics Engine counters, which aren't
per-name-revocable and aren't meant to be).

**Deferred — real-device verification (owner-executed, not done by this
build):** confirming the redirect actually works, and that installing the
PWA is unaffected, on the owner's own iPad (an installed-PWA `GET /<name>`
navigation reaching the network, not a stale cache — see
`_bmad-output/implementation-artifacts/spec-8-3-source-links.md`'s own
Deferred note and `_bmad-output/implementation-artifacts/deferred-work.md`).
Do not treat this as verified until that real-device check has actually
happened.

---

## 12. The Governor reports its own state (Story 8.5) — `gov_gauge` / `ceiling_80` / `ceiling_reached` / `killswitch_seen`

**Status:** live today as code. Zero new surface on `functions/governor.js` /
`functions/lib/governor-do.js` / `functions/lib/governor-core.js` — this
story reuses Story 8.4's existing `getDailyImageCounts(budgetDay)` Governor
RPC method as-is; everything new lives in `functions/lib/events.js` (two new
additive exports) and `functions/api/transform.js` (the wiring).

**What writes it:** every REAL image-spend commit — the `image_created`
success path inside `runModelAndSettle`, for BOTH the subscriber and
free-device callers — also, via `ctx.waitUntil` (fire-and-forget, never
delays or fails the image response it accompanies), calls the new
`reportGovernorGauge()` helper in `functions/api/transform.js`. The
free-device path's separate `mint` reservation commit (minting a `d1.`
device token) is explicitly excluded — a mint is not "an Image," and never
reaches `runModelAndSettle` at all.

- **`gov_gauge`** — one Analytics Engine data point per real commit, via the
  new `writeGovGauge(env, ctx, {total, free, sub, ceiling})` export in
  `functions/lib/events.js`: `{blobs:["gov_gauge"], doubles:[total, free,
  sub, ceiling], indexes:["gov_gauge"]}`, written to the SAME `FUNNEL`
  Analytics Engine dataset (§1.10/Story 8-1's binding) every other funnel
  event already uses. `total`/`free`/`sub` come straight from
  `getDailyImageCounts(budgetDay)`; `ceiling` is `cfg.ceiling`, already
  loaded by the caller. Same fail-open contract as `writeEvent` — an absent
  `env.FUNNEL` (every dev/test context today) is a silent no-op; a throwing
  `writeDataPoint` is caught and logged (`event_write_failed`), never
  propagated.
- **`ceiling_80` / `ceiling_reached`** — fired the first time today's
  `total/ceiling` reaches 0.8 / 1.0, tracked by a new `state:<budgetDay>` KV
  key (same `STATE_KV` binding as `cfg:governor`) so each fires **at most
  once per UTC budget day**. Shape: `{ceiling80?: true, ceilingReached?:
  true}` — an absent field means "not yet crossed today"; a commit that
  jumps straight past both thresholds in one step records both flags in a
  single KV write and fires both alerts. Below 80%, this key is never even
  read. The key carries a 3-day `expirationTtl` (comfortably past the one
  UTC day it's ever consulted for), so it self-cleans — there is no separate
  sweep job.
- **`killswitch_seen`** — fires at BOTH of `transform.js`'s `503
  {error:{code:"resting"}}` sites (the `AI_ENABLED` Kill Switch, §1.3; and
  an invalid/unreadable `cfg:governor`, §1.4) — the two answer the identical
  observable response, so this alert does not distinguish which underlying
  reason tripped it. Never delays the 503 it accompanies.

**The one place to change for a real push channel:** `notifyAlert(env, ctx,
event)` (`functions/lib/events.js`) is the ONLY call site anywhere in this
story's code that ever writes `ceiling_80`/`ceiling_reached`/
`killswitch_seen` (a static repo-wide check in `scripts/check-config.mjs`
proves this) — today it's a thin wrapper around `writeEvent(env, ctx, event,
"")`, gated by a small local allowlist (`ALERT_EVENTS`) so it can never be
called with an arbitrary string. Wiring a real notification (Telegram, ntfy,
email, …) into this alerting path means editing ONLY this one function —
nothing in `transform.js` needs to change.

**How to read these today:** `scripts/readout.mjs` (Story 8.6, §13 below)
reads today's `gov_gauge` row directly — it does not read
`ceiling_80`/`ceiling_reached`/`killswitch_seen` themselves (those are
one-off alert events, not a gauge). For those three, or for anything
`readout.mjs` doesn't cover, query the `FUNNEL` Analytics Engine dataset
directly via its SQL REST API (§1.10) for `blob1 = 'gov_gauge'` (or
`'ceiling_80'`/`'ceiling_reached'`/`'killswitch_seen'`), or read the existing
daily rollup (`functions/lib/rollup.js`) once `ANALYTICS_READ_TOKEN`/
`CF_ACCOUNT_ID` are set. None of the three alerts, nor the gauge itself,
produce any `wrangler tail`/console output on the happy path — only this
story's own failure modes do, each a fixed, sanitized event code (no raw
error, no identifier): `gov_gauge_rpc_failed` (the `getDailyImageCounts` RPC
threw/rejected), `gov_gauge_state_read_failed` /
`gov_gauge_state_write_failed` (the `state:<budgetDay>` KV read/write
failed), and `gov_gauge_report_failed` (an unexpected error anywhere else in
`reportGovernorGauge`) — every one logged and swallowed; the image response
it was piggybacking on is always already sent, completely unaffected.

---

## 13. The owner's one-command readout (Story 8.6) — `scripts/readout.mjs`

**Status:** code-complete and unit-tested (`test/readout.test.mjs`) against
mocks — same posture as Story 8.4/8.5's own scripts (§1.10, §12): no real
Cloudflare account exists in this build's session, so it has never actually
run against live data. See `deferred-work.md`'s Story 8-6 entry.

**What it's for:** one command that replaces opening several Cloudflare
dashboards to see how the service is doing right now. Read-only — it writes
nothing anywhere (no KV, no Analytics Engine, no Governor).

**How to run it:**

```
node scripts/readout.mjs
node scripts/readout.mjs --views 50000
```

Needs, as plain env vars (never committed, never Worker secrets):
`CF_ACCOUNT_ID` and `ANALYTICS_READ_TOKEN` (§1.10, §2.5 — same two the daily
rollup and backfill already use) for sections 1–2, and `CF_KV_READ_TOKEN`
(§2.5 — a new, read-only-scoped token, separate from both of those) for
section 3 (and therefore section 4, which depends on it). Any of the three
missing degrades only the section(s) that need it to a clear "unavailable"
line — the script still prints whatever it could and always exits `0` (a
report for a human, not a CI gate).

**What each section means:**

1. **Today's Images vs. ceiling** — the most recent `gov_gauge` data point
   (§12) written so far today, as `total/ceiling` — e.g. `20/40 = 50.0%`. If
   no Image has been requested yet today, prints "no data yet today", never
   a fabricated `0%`.
2. **Last 15 minutes' image failure rate** — `image_failed / (image_created
   + image_failed)` over a rolling 15-minute window. Only marked `FLAGGED`
   when the ratio is **over** 20% **and** there were at least 5 attempts in
   that window — under 5 attempts, the raw ratio (or "not enough data")
   prints but is never flagged, however high it is.
3. **Last 30 days' rollup table** — one row per real `rollup:<date>` KV
   entry (§1.10/Story 8-4) found for the last 30 calendar days ending
   yesterday (today's own day isn't rolled up yet); a day with no rollup yet
   is simply absent from the table, never padded with a fabricated zero row.
4. **`--views <n>` (optional) — SM-1/SM-2** — the PRD's own Success Metrics
   (prd.md §7), computed from the same rollup days found in section 3:
   - **SM-1** (view-to-visit rate) = (sum of every available day's Source
     Link visit totals) ÷ `n`, against the PRD's own ≥ 1% target. `n` is
     typed in by hand from YouTube's own analytics — this script never
     scrapes or calls any video platform.
   - **SM-2** (visit-to-paid rate) = (sum of `purchase_completed`) ÷ (sum of
     `app_open`) across those same days, against the PRD's own ≥ 0.6%
     target (below 0.3% is a stop signal) — printed as **inconclusive**
     instead of a percentage whenever the summed Source Link visit count
     (the same sum SM-1 uses) is under 1,000, per the PRD's own literal
     rule, regardless of what the raw ratio would otherwise show.
   - **Scope note:** the PRD defines SM-1 over 30 days and SM-2 over 90
     days; this script computes both over whatever rollup days are actually
     available (up to 30, per §1.10's own retention/backfill window) — a
     rolling recent-trend view, not a strict PRD-exact 90-day computation.
     See the Story 8-6 spec's own Design Notes/Spec Change Log.

**Where it fits the other tools:** §6 (bill-spike response) and §12
(Governor state) both now point here as the first place to look — it's
built on top of `functions/lib/rollup.js` (§1.10) and `gov_gauge` (§12), not
a new data source of its own.

## 14. Live dashboard checklist (Story 9-3) — verify on the real account before go/no-go

**Status:** NOT STARTED. Every item below needs a real, deployed production
account and Cloudflare/Stripe dashboard access this build session does not
have (no `wrangler` command has ever been run; nothing here has been
deployed). This section only consolidates WHERE each item's own detail
already lives (§1.1–§1.12 above) into one checklist the owner can tick
straight through, with a date and how it was checked, per Story 9.3's own
AC. Do not tick an item here until it is genuinely verified on the live
account — an unticked item is automatically a blocker for Story 9.5's
go/no-go decision (its own AC says so explicitly).

- [ ] **WAF rate-limit rule** exists and matches §1.1's shape. _Verified:
      ______ (date) by: _______
- [ ] **The disabled WAF custom rule** that backs up the Kill Switch (§1.2)
      exists and is genuinely disabled (not deleted — it must be ready to
      enable in seconds during a drill). _Verified: ______ by: _______
- [ ] **Turnstile widget** — site key, hostname allowlist, and the real
      secret set via `wrangler secret put TURNSTILE_SECRET` (§1.5, §2.4).
      _Verified: ______ by: _______
- [ ] **Stripe webhook endpoint** — the right events subscribed, and the
      pinned `api_version` (§1.6) matches `lib/stripe.js`'s own pinned
      version exactly. _Verified: ______ by: _______
- [ ] **Stripe renewal, cancellation, and failed-payment emails** are
      enabled and use Stripe's own default templates or better (§1.7).
      _Verified: ______ by: _______
- [ ] **The Terms URL** in Stripe's public business details points at the
      live `terms.html` (§1.8). _Verified: ______ by: _______
- [ ] **The complimentary family code** — Story 9-1's coupon/promotion
      code exists, is restricted to the family's own customer, and was
      redeemed successfully (§1.9, and this build's own Story 9-1 audit —
      the code side is already proven; only the live redemption itself is
      still open). _Verified: ______ by: _______
- [ ] **The read-only Analytics Engine token** (`ANALYTICS_READ_TOKEN`) is
      created with exactly the Account Analytics: Read scope, and
      `CF_ACCOUNT_ID`/`CF_KV_READ_TOKEN`/`CF_KV_WRITE_TOKEN` all exist as
      the story-8 scripts need them (§1.10, §2.5). _Verified: ______ by:
      _______
- [ ] **The full list of Worker secrets and vars** matches §2's own table
      exactly — no forgotten secret, no leftover test-mode value live in
      production. _Verified: ______ by: _______
- [ ] **Live Prices exist and the paywall shows them.** ⚠ **Note on
      epics.md's own AC text:** Story 9.3's AC in `epics.md` literally
      names "yearly 99 RON and monthly 14.99 RON" — those figures are
      STALE. The actual, deliberate, currently-committed pricing (confirmed
      against `docs/business-analysis.md`'s own explicit recommendation,
      "Keep 19.99 RON/month and 149 RON/year," and `wrangler.jsonc`'s
      committed `PRICE_MONTHLY_RON: "19.99"` / `PRICE_YEARLY_RON: "149"`)
      is **19.99 RON/month and 149 RON/year** — verify THESE two live
      Stripe Prices exist and that the paywall shows exactly these amounts,
      not the epics.md text's stale figures. _Verified: ______ by: _______
- [ ] **`node scripts/check-public.mjs <production URL>` passes** against
      the real deployed domain (§ "AD-9"/Story 4.1's own check — confirms
      no server file, doc, or script is served, and the real client files
      are). _Verified: ______ by: _______
- [ ] **`node scripts/abuse-check.mjs --post-deploy <url>` passes**, and
      the run is recorded with the date and commit (§10.2/§10.3) — also
      confirms no Worker other than the one production Worker still holds
      the `AI` binding (Story 9.2's own AC, once 9.2 is actually built —
      see `spec-9-2-retire-8ishqa.md`). _Verified: ______ by: _______

**Any item left unticked above is, by this story's own AC, a blocker for
Story 9.5's go/no-go decision** — list it explicitly in that decision
record rather than silently proceeding.
