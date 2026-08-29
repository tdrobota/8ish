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

No build step — it's plain HTML/CSS/JS. Serve the folder with any static
file server, e.g.:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Structure

- `index.html`, `style.css`, `app.js`, `ui.js` — the app (index.html also
  holds the shared SVG pictogram sprite used by Jocuri; ui.js is the shared
  UI kernel — screens registry, icon helper, countdown ring)
- `questions.js` — the ~200-question seed bank
- `challenges.js` — the on-camera dare seed bank
- `games.js` — the traditional Romanian games seed bank (name, description,
  players, and illustrated steps per game)
- `manifest.webmanifest`, `sw.js`, `icons/` — installable, offline PWA support
- `fonts/` — self-hosted Poppins (so it works offline too)
- `monetize.js` — free daily limit / Parent Gate / 8ish+ paywall (only active
  when `/api/config` reports `planMode: "free"`; a no-op on the kid's deploy)
- `functions/api/config.js`, `checkout.js`, `checkout-confirm.js`,
  `entitlement.js` — Cloudflare Functions backing the above, wired in
  `worker.js`

## Deploy

This one codebase deploys as **two separate Workers**, both defined in
`wrangler.jsonc`:

- **Kid's link** (`npx wrangler deploy`, no `--env`) — always unlimited, no
  counter, no Parent Gate, no paywall. Never point Stripe keys at this one.
- **Public/monetized link** (`npx wrangler deploy --env plus`, Worker name
  `8ish-plus`) — enforces the free daily/AI limits from `wrangler.jsonc`'s
  `env.plus.vars` and unlocks via Stripe Checkout.

### Go-live checklist for the `plus` deploy

1. `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
2. In Stripe, create two recurring Prices (RON monthly ~19.99, yearly ~149)
   and grab their `price_...` ids.
3. Put those ids in `wrangler.jsonc` → `env.plus.vars.STRIPE_PRICE_MONTHLY`
   / `STRIPE_PRICE_YEARLY` (not secret, safe to commit).
4. `npx wrangler secret put STRIPE_SECRET_KEY --env plus` (the real secret —
   never put this in `wrangler.jsonc`, and never set it on the default env).
5. `npx wrangler deploy` and `npx wrangler deploy --env plus`.

No Stripe webhook is required for V1 — entitlement is confirmed when Stripe
redirects back after checkout, then rechecked at most once a day per device.
That means a cancellation can take up to ~24h to actually lock the app back
down; fine for a first version, worth revisiting once there are real
subscribers.
