// Worker entry point for the deployed build (`npx wrangler deploy`, see
// wrangler.jsonc). This project deploys as a plain Worker with static
// assets, not classic Cloudflare Pages, so `functions/` is not
// auto-detected — this file is the explicit route for anything the static
// assets layer doesn't match. Static files are served automatically by the
// assets binding before this fetch handler ever runs (assets-first
// routing), so only `/api/transform` needs to be wired here.
import { onRequestPost as transformPost } from "./functions/api/transform.js";
import { onRequestGet as configGet } from "./functions/api/config.js";
import { onRequestPost as checkoutPost } from "./functions/api/checkout.js";
import { onRequestPost as checkoutConfirmPost } from "./functions/api/checkout-confirm.js";
import { onRequestPost as entitlementPost } from "./functions/api/entitlement.js";
import { onRequestPost as restorePost } from "./functions/api/restore.js";
import { onRequestPost as stripeWebhookPost } from "./functions/api/stripe-webhook.js";
import { onRequestPost as subscriptionPost } from "./functions/api/subscription.js";
import { onRequestPost as eventsPost } from "./functions/api/events.js";
import { writeEvent } from "./functions/lib/events.js";
import { handleSourceLinkRequest } from "./functions/lib/source-links.js";
import { buildRollup, yesterdayUtcDate } from "./functions/lib/rollup.js";
// The Governor Durable Object class (Story 7-2) -- re-exported so
// wrangler.jsonc's `durable_objects` binding's `class_name: "Governor"`
// resolves against this Worker's own bundled module graph, since
// `wrangler.jsonc`'s `main` is this single entry file (see
// functions/governor.js's own header comment for the full reasoning). No
// caller in this repo invokes the binding yet -- that's Story 7.5.
export { Governor } from "./functions/governor.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transform") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return transformPost({ request, env, ctx });
    }

    if (url.pathname === "/api/config") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return configGet({ request, env, ctx });
    }

    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return checkoutPost({ request, env, ctx });
    }

    if (url.pathname === "/api/checkout/confirm") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return checkoutConfirmPost({ request, env, ctx });
    }

    if (url.pathname === "/api/entitlement") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return entitlementPost({ request, env, ctx });
    }

    if (url.pathname === "/api/restore") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return restorePost({ request, env, ctx });
    }

    if (url.pathname === "/api/webhooks/stripe") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return stripeWebhookPost({ request, env, ctx });
    }

    if (url.pathname === "/api/subscription") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return subscriptionPost({ request, env, ctx });
    }

    if (url.pathname === "/api/e") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return eventsPost({ request, env, ctx });
    }

    // Source Links (Story 8-3) -- GET /<name> for a name in the SOURCE_LINKS
    // var. Real static assets are served automatically BEFORE this fetch
    // handler ever runs (assets-first routing, see this file's header
    // comment), so a name only ever reaches here if no real file already
    // matched it -- no precedence surprise, and scripts/check-config.mjs's
    // own static check keeps a configured name from ever colliding with a
    // real asset path or "api"/"sw" in the first place.
    const sourceLinkResponse = handleSourceLinkRequest(request, env, ctx, writeEvent);
    if (sourceLinkResponse) return sourceLinkResponse;

    return new Response("Not found", { status: 404 });
  },

  // Story 8-4: the daily rollup Cron Trigger (`0 3 * * *` UTC -- see
  // wrangler.jsonc's own `triggers.crons`). Per Cloudflare's module-Worker
  // convention (confirmed against developers.cloudflare.com/workers/
  // runtime-apis/handlers/scheduled/), a second `async scheduled(event,
  // env, ctx)` method sits alongside `fetch` on this same default-exported
  // object; `event` carries `.cron`/`.scheduledTime`, neither of which is
  // used here -- this handler always computes "yesterday" from the real
  // clock (never from `event.scheduledTime`), so a delayed or manually
  // re-triggered delivery still targets a sensible day, and running it
  // twice for the same day is naturally idempotent (same query, same day).
  //
  // All the real work (both source reads, and never writing anything
  // partial) lives in functions/lib/rollup.js's buildRollup() -- this
  // handler only supplies the real bindings/fetch/clock and does the one
  // KV write. `env.CF_ACCOUNT_ID`/`env.ANALYTICS_READ_TOKEN` are genuinely
  // absent in every env this build ever runs in (no live Cloudflare
  // account here) -- buildRollup() degrades to `null` in exactly that
  // case, so this handler writes nothing and does not throw, same as any
  // other source failure.
  //
  // The runtime already awaits the promise `scheduled()` itself returns
  // (Cloudflare's own docs: "ctx.waitUntil() is most useful when you need
  // to run multiple concurrent tasks... [it] is not required" for a single
  // awaited operation) -- ctx.waitUntil() is used anyway here, wrapping
  // only the KV write, to explicitly extend the event's lifetime for that
  // one background operation, matching this repo's existing waitUntil()
  // convention for "finish this after the main work is decided" writes
  // (functions/lib/events.js's own writeEvent()).
  async scheduled(event, env, ctx) {
    const date = yesterdayUtcDate(Date.now());
    const governorStub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
    const rollup = await buildRollup({
      fetchFn: fetch,
      accountId: env.CF_ACCOUNT_ID,
      readToken: env.ANALYTICS_READ_TOKEN,
      governorStub,
      date,
    });
    if (rollup === null) return;
    ctx.waitUntil(env.STATE_KV.put(`rollup:${date}`, JSON.stringify(rollup)));
  },
};
