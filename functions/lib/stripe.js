// Stripe REST client -- the ONLY file in this repo allowed to hold the
// literal "api.stripe.com" or a `Stripe-Version` string (scripts/check-config.mjs
// grep-checks this). Every other file that needs Stripe calls `get`/`post`
// here instead of calling `fetch` directly, so the pinned API version and
// auth header can never drift between call sites (Story 6-1, AD-17).
//
// The pinned version must stay in lockstep with the Stripe Dashboard
// webhook endpoint's own `api_version` setting (see docs/runbook.md §1.4) --
// moving to a newer Stripe API version is a deliberate, separately tested
// change, never a silent drift between the two.

export const STRIPE_API_VERSION = "2025-03-31.basil";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

// Thrown for any non-2xx Stripe response; `status` lets a caller branch on
// e.g. 404 without inspecting the response body. A network failure (fetch
// itself rejecting -- DNS, TLS, connection reset) throws whatever error
// `fetch` throws instead, so callers can distinguish "Stripe answered with
// an error" from "Stripe was unreachable" via `instanceof StripeError`.
export class StripeError extends Error {
  constructor(status) {
    super(`stripe_error_${status}`);
    this.name = "StripeError";
    this.status = status;
  }
}

function authHeaders(env, extra) {
  return {
    authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_API_VERSION,
    ...extra,
  };
}

async function toJsonOrThrow(response) {
  if (!response.ok) {
    throw new StripeError(response.status);
  }
  return response.json();
}

// GET https://api.stripe.com/v1/<path> -- `path` may carry its own query
// string (e.g. "customers?email=..."). Returns the parsed JSON body; throws
// StripeError on a non-2xx response.
export async function get(env, path) {
  const response = await fetch(`${STRIPE_API_BASE}/${path}`, {
    headers: authHeaders(env),
  });
  return toJsonOrThrow(response);
}

// POST https://api.stripe.com/v1/<path> with an
// application/x-www-form-urlencoded body built from `params` (a plain
// object of string values, or a URLSearchParams instance). Returns the
// parsed JSON body; throws StripeError on a non-2xx response.
export async function post(env, path, params) {
  const body = params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
  const response = await fetch(`${STRIPE_API_BASE}/${path}`, {
    method: "POST",
    headers: authHeaders(env, { "content-type": "application/x-www-form-urlencoded" }),
    body: body.toString(),
  });
  return toJsonOrThrow(response);
}
