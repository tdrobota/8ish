# Question Cards

A tiny offline-first PWA of activities for kids. Întrebări/Provocări tap the
screen for a new full-screen, all-caps question or challenge (no repeats
within a session, nothing saved anywhere); Jocuri is a browsable list of
traditional Romanian children's games with illustrated how-to-play
instructions. Built for an iPad Pro 10.5" (2017) running Safari.

## Use it

Open the deployed URL on the iPad in Safari, then Share → Add to Home Screen.
Once installed, it works with no internet connection.

## Develop locally

No build step — it's plain HTML/CSS/JS. The client files all live in `public/`,
which is the only folder that is ever published. Serve that folder with any
static file server, e.g.:

```
python3 -m http.server 8080 --directory public
```

Then open `http://localhost:8080`. (The `/api/*` calls need `worker.js`, so use
`npx wrangler dev` if you want those too; it serves `public/` first and
`worker.js` for everything else, like the deployed site. Note that it calls the
real, billed Workers AI.)

### Checks

`npm ci && npm run check` installs the pinned `wrangler` devDependency (the
only dependency this repo has) and then runs a fixed allowlist of
`scripts/check-*.mjs` scripts, in this order — `check-sw.mjs`,
`check-config.mjs`, `check-i18n.mjs`, then `check-public.mjs --self-test` —
stopping at the first failure and printing that check's full output. It is
not auto-discovery: a `check-*.mjs` file that exists but isn't in that list
fails the whole run instead of being silently skipped or silently run; a new
check script must be added to the `ORDER` list in `scripts/run-checks.mjs`
before it takes part. This is what the Workers Builds pipeline runs before
every deploy (see "Deploy" below); run it locally the same way before
pushing:

```
npm ci
npm run check
```

`check-public.mjs` runs with `--self-test` here because there is no live URL
before a deploy; running it against the real deployed domain is a separate,
manual, post-deploy step (see "Deploy"). `scripts/run-checks.mjs` also has its
own `--self-test`, which proves its ordering and stop-on-first-failure logic
against throwaway fixture scripts rather than the real checks:
`node scripts/run-checks.mjs --self-test`.

A failed build only blocks the deploy step — the previously deployed Worker
keeps serving unchanged, so a failing check never causes downtime, only a
blocked release.

### Only `public/` is published

Publication is an allowlist by location: `wrangler.jsonc` sets
`assets.directory` to `./public`, so a file is public only if it sits in
`public/`. Server and repo files (`worker.js`, `functions/`, `wrangler.jsonc`,
`docs/`, `stats/`, `scripts/`, `uploads/`, `README.md`) stay at the repo root
and are never served. Do not put anything in `public/` that should not be
public.

`scripts/check-public.mjs` proves it on a running site: it requests the
server-side paths (for example `/worker.js`, `/docs/...`, `/wrangler.jsonc`,
`/scripts/...`), which must all answer 404, and `/`, `/index.html` and `/sw.js`,
which must be served. A 200 fallback page for a forbidden path fails it. To add a
path to guard, add a line to `MUST_BE_404` in the script.

```
node scripts/check-public.mjs http://localhost:8787
node scripts/check-public.mjs --self-test
```

The first form checks a running site (local or deployed); `--self-test` proves
the check itself rejects a bad server. It exits non-zero on any failure. (On
Cloudflare `/index.html` redirects to `/`; the check accepts that for
`/index.html` only.)

### Service worker rules and the check

`sw.js` is an allowlist. Only the files in its `PRECACHE_URLS` are served
cache-first (that is what makes the shell and every Activity work offline); the
Terms and Privacy pages are network-first with the cached copy used only
when offline or when the server answers with an error (5xx); everything else,
in particular every `/api/*` call, goes straight to the network and is never
cached, so an installed app always shows the real subscription, prices and
limits.

`scripts/check-sw.mjs` runs the worker in a sandbox and proves each rule. It
needs Node 18+ and no packages:

```
node scripts/check-sw.mjs
```

It prints one line per check and exits non-zero if any fails. `npm run check`
runs it first, before every deploy (see "Checks" above).

- **When to bump `CACHE_NAME`** (in `sw.js`, `qcards-vNN`): whenever a precached
  file changes, `PRECACHE_URLS` changes, or `sw.js` itself changes. Devices only
  fetch new copies of the files when the version changes, and the new worker
  deletes every older cache when it activates. The check asserts the version is
  at least `NEXT_VERSION` (top of `scripts/check-sw.mjs`); raise that number to
  the version you just set so the check keeps guarding against a lower one.
- **To add a precached asset** (a new script, stylesheet, font or icon that
  `index.html` or the manifest loads): add its `./path` to `PRECACHE_URLS`, bump
  `CACHE_NAME`, then run the check. The check fails if something the app loads
  is missing from `PRECACHE_URLS`, because that file would not load offline.
- Do not add runtime `cache.put` calls. The check allows exactly one, the
  refresh of the Terms and Privacy pages.

### Child-safe strings and the i18n check

Every i18n key that only a parent sees carries the prefix `parent.`; every other
key is child-facing. The "For parents" button label (`parentModeBtn`) is the
one allowed exception: it is the only non-`parent.` key a parent-only screen may
use. The parent-only screens in `index.html` are `parentGate`, `parentsHub`,
`paywall`, `restore` and `restoreCodeReveal`.

`scripts/check-i18n.mjs` reads the real `i18n.js`, `index.html` and the scripts
`index.html` loads, then runs its own good and bad fixtures. Node 18+, no
packages:

```
node scripts/check-i18n.mjs
```

It prints one line per check and exits non-zero if any fails. It fails on:

- a purchase stem (buy, unlock, subscribe, premium, ask a parent, cumpăr,
  deblocheaz, abon, plăt, cere/roagă ... părinte, matched without regard to case
  or diacritics) in a child-facing string in either language, or in the default
  text (text, `aria-label`, `alt`, `placeholder`, `title`) of a child-facing
  element in `index.html`
- a key that exists in Romanian or English only, a value that is not text or is
  empty, or `{placeholder}` tokens that differ between the two languages
- a run that loaded none of `app.js`, `ui.js`, `draw.js` and `monetize.js`
  (it would be scanning nothing)
- a `data-i18n*` attribute, a `t("...")` literal or a `draw.js` message key
  that is not defined in both languages (it would show as raw text)
- a `parent.` key on a child element or in `app.js`/`draw.js`/`ui.js`, or a
  non-`parent.` key on a parent-only screen

Text under a `parent.*` key may use purchase words, and the bare product name
`8ish+` always passes. A key nothing uses is only printed as information. To add
a stem, add it to `STEMS` (and a sample to `STEM_SAMPLES`) in the
script. `npm run check` runs it, third, before every deploy (see "Checks"
above).

Known limits:

- Only literal `t("key")` and `I18N.t("key")` calls are scanned. A key built at
  run time is not, and shows up as unused.
- Hard-coded strings inside scripts are not scanned for purchase stems.
- JS comments are not stripped, so a commented-out call can cause a false
  failure (the safe direction).
- The `plat` stem is broad on purpose; reword the child string rather than
  loosen the stem.
- When a parent-only screen or script is added, edit `PARENT_SCREENS` or
  `PARENT_SCRIPTS` in the script.
- Output is the real-file checks first, then the fixtures, so a content failure
  appears in the real-file lines at the top.

## Structure

Everything the site serves is in `public/`; the rest of the repo is never published.

- `public/index.html`, `public/style.css`, `public/app.js`, `public/ui.js` — the
  app (index.html also holds the shared SVG pictogram sprite used by Jocuri;
  ui.js is the shared UI kernel — screens registry, icon helper, countdown
  ring)
- `public/questions.js` — the ~200-question seed bank
- `public/challenges.js` — the on-camera dare seed bank
- `public/games.js` — the traditional Romanian games seed bank (name, description,
  players, and illustrated steps per game)
- `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` — installable,
  offline PWA support
- `scripts/check-sw.mjs` — plain-Node check of the service worker's cache
  rules (run by hand: `node scripts/check-sw.mjs`); not published (outside
  `public/`)
- `scripts/check-config.mjs` — plain-Node check that a failed, slow or invalid
  `/api/config` answer never makes the app unlimited (run by hand:
  `node scripts/check-config.mjs`); not published (outside `public/`)
- `scripts/check-i18n.mjs` — plain-Node check that child-facing strings have no
  purchase language, RO/EN keys match, every used key is defined, and `parent.`
  keys stay on parent-only screens (run by hand: `node scripts/check-i18n.mjs`);
  not published (outside `public/`)
- `scripts/check-public.mjs` — plain-Node check, run against a local or deployed
  URL, that server-side paths answer 404 and the app paths are served (see
  "Only `public/` is published"); not published (outside `public/`)
- `scripts/run-checks.mjs` — runs the four `check-*.mjs` scripts above in
  order, stopping at the first failure (`npm run check`); not published
  (outside `public/`)
- `package.json`, `package-lock.json` — pin the one dependency, `wrangler`
  (a devDependency, exact version); not published (outside `public/`)
- `public/fonts/` — self-hosted Poppins (so it works offline too)
- `public/monetize.js` — free daily limit / Parent Gate / 8ish+ paywall (only active
  when `/api/config` reports `planMode: "free"`; a no-op on the kid's deploy)
- `functions/api/config.js`, `functions/api/checkout.js`,
  `functions/api/checkout-confirm.js`, `functions/api/entitlement.js`,
  `functions/api/restore.js` — Cloudflare Functions backing the above,
  wired in `worker.js`. Restore requires both the subscriber's email AND a
  one-time restore code shown once at purchase (`checkout-confirm.js` issues
  it, only ever storing its hash) — trusting a submitted email alone would
  let anyone who knew a customer's email steal their subscription; see the
  comments in `restore.js` for why.

## Deploy

This codebase deploys as **one Worker**, `8ish-plus`, declared at the top
level of `wrangler.jsonc` (no `env` blocks): `npx wrangler deploy`, no flag.
It enforces the free daily/AI limits from `wrangler.jsonc`'s `vars` and
unlocks via Stripe Checkout. It's bound to the custom domains `8ish.app` and
`www.8ish.app`.

(An older `8ishqa` Worker — an always-unlimited kid's-own link — is retired
from this repo; it keeps running its last deployed code until it is deleted
in a later epic, and must not be redeployed or reconfigured from this repo
before Epic 9 deletes it.)

Only `public/` is published (`assets.directory` is `./public`); `worker.js`
and `functions/` are the Worker code, not files served to browsers. After a
deploy, `node scripts/check-public.mjs https://<the site>` confirms nothing
else is reachable.

### Workers Builds connection (owner, dashboard)

The actual pipeline connection lives in the Cloudflare dashboard, not in this
repo, and is set up by the owner:

- **Repo:** `tdrobota/8ish`, **branch:** `main`, **root directory:** `/`.
- **Build command:** `npm ci && npm run check`.
- **Deploy command:** `npx wrangler deploy` (Cloudflare's own default for a
  Workers Builds project). It only runs if the build command exits 0, so a
  failing check already blocks the deploy without this repo chaining them
  itself.

Repointing the dashboard connection from the old, retiring `8ishqa` project to
`8ish-plus` with a fresh least-privilege build token, and disabling the old
connection so it can't redeploy `8ishqa`, are the owner's dashboard-only steps
(tracked as sprint action items, not done by this repo). The build token
itself is created and managed by Cloudflare's own "Create new token" flow in
the Workers Builds dashboard when connecting the repo — there is nothing to
generate or wire into this repo for it.

### Go-live checklist

1. `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. In Stripe, create two recurring Prices (RON monthly ~19.99, yearly ~149)
   and grab their `price_...` ids.
3. Put those ids in `wrangler.jsonc` → `vars.STRIPE_PRICE_MONTHLY` /
   `STRIPE_PRICE_YEARLY` (not secret, safe to commit).
4. `npx wrangler secret put STRIPE_SECRET_KEY` (the real secret — never put
   this in `wrangler.jsonc`).
5. `npx wrangler deploy`.
6. `node scripts/check-public.mjs https://<the deployed domain>` — confirms
   only `public/` is reachable and nothing else leaked.

No Stripe webhook is required for V1 — entitlement is confirmed when Stripe
redirects back after checkout, then rechecked at most once a day per device.
That means a cancellation can take up to ~24h to actually lock the app back
down; fine for a first version, worth revisiting once there are real
subscribers.

No email-sending setup is needed either: instead of emailing a one-time
restore code (which would require Cloudflare's Email Sending product and the
paid Workers plan), the restore code is shown once on-screen right after
checkout completes, and the family is expected to save it themselves — same
trade-off as any password-reset recovery code. If they lose it and both
devices' local storage, there's currently no self-serve recovery path; that's
an accepted limitation at this hobby scale, not an oversight.
