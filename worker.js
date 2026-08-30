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
import { onRequestGet as checkoutConfirmGet } from "./functions/api/checkout-confirm.js";
import { onRequestGet as entitlementGet } from "./functions/api/entitlement.js";
import { onRequestPost as restorePost } from "./functions/api/restore.js";

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
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return checkoutConfirmGet({ request, env, ctx });
    }

    if (url.pathname === "/api/entitlement") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      return entitlementGet({ request, env, ctx });
    }

    if (url.pathname === "/api/restore") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      return restorePost({ request, env, ctx });
    }

    return new Response("Not found", { status: 404 });
  },
};
