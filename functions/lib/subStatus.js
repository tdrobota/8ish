// The one writer/reader of `subStatus:<sub>` in STATE_KV (Story 6-1, AD-17).
// No other file calls env.STATE_KV.get/put on a `subStatus:` key -- centralizing
// it here is what lets `write()` enforce a single ordering rule everywhere:
// a lost or out-of-order webhook can otherwise resurrect a cancelled
// subscription (an old "active" event landing after a newer "cancelled"
// one) or leave a cancelled one looking "active" forever (a lost webhook
// with nothing to expire it).
//
// Stored shape: { active: boolean, asOf: number (ms), source: string,
// currentPeriodEnd: number|null }. Only stripe-webhook.js calls write() --
// it is the one authoritative, push-based source of truth for the KV
// record, with its own asOf drawn from the Stripe event's own timestamp
// (see that file). read()'s live-Stripe fallback below deliberately never
// calls write(): a live lookup's own asOf could only ever be "now", which
// would unfairly outrank a genuinely newer webhook event still working
// through Stripe's retry queue (its event.created might be a few minutes
// in the past by the time it's finally delivered) -- letting a live lookup
// write to KV would let that legitimate webhook write get rejected as
// "stale" by mistake. So:
//
//  - write() only applies when `asOf >= stored.asOf` (or nothing is stored
//    yet) -- a stale write is rejected, not merged or queued. asOf must be
//    a finite number -- an invalid asOf (e.g. NaN, where `NaN < x` is
//    always false) throws rather than silently bypassing the guard.
//  - An `active: true` write carries a 6h `expirationTtl`, so a lost/never-
//    received webhook self-heals: the entry ages out of KV and the next
//    read() falls back to a live Stripe lookup -- which does NOT refresh
//    the KV entry itself; only a future webhook write does that.
//  - An inactive write carries no expiry -- once we know a subscription is
//    inactive there is nothing to self-heal (only a newer event, e.g. a
//    resume, moves it back to active, which is a fresh write with its own
//    asOf).
//
// read() is KV-first with a live-Stripe fallback (via lib/stripe.js, never
// a direct fetch -- see that file's own comment). Because that fallback
// never touches KV, a burst of reads for a subscription with no (or an
// expired) KV entry would otherwise call Stripe once per read; the 60s
// `lookupCache` below -- a plain module-scope Map, isolate-lifetime only --
// fixes that by sharing one in-flight lookup (keyed by subscription id)
// across every read() call in the same isolate for 60s. It caches whatever
// the live lookup resolves to -- an active result, an inactive one, or
// "unknown" (404) alike -- not only negative outcomes, despite the
// "unknown/inactive" framing in the story's own acceptance criteria; that
// framing just describes the common case (an *active* subscription usually
// already has a fresh, webhook-written KV entry and never reaches this
// path). This is a best-effort dedup only -- the isolate can be recycled
// at any time, and it is never itself the source of truth; KV is. Settled
// entries older than the window are swept opportunistically on each read()
// call so the map can't grow unboundedly over an isolate's lifetime.

import { get, StripeError } from "./stripe.js";

const KV_PREFIX = "subStatus:";
const ACTIVE_TTL_SECONDS = 6 * 60 * 60; // 6h -- see file header
const LOOKUP_CACHE_MS = 60 * 1000; // 60s -- see file header

// module-level, isolate-lifetime only: subscriptionId -> { checkedAt, promise, settled }
const lookupCache = new Map();

// Thrown by the live-lookup fallback when STRIPE_SECRET_KEY isn't set, so a
// caller (entitlement.js) can map it to its own "not_configured" response
// distinctly from a genuine Stripe/network failure -- and so a KV cache hit
// never has to pay for this check at all (it only matters once a live call
// is actually about to happen).
export class NotConfiguredError extends Error {
  constructor() {
    super("stripe_not_configured");
    this.name = "NotConfiguredError";
  }
}

function kvKey(subscriptionId) {
  return `${KV_PREFIX}${subscriptionId}`;
}

// The active set is exactly `active` and `trialing`; every other Stripe
// subscription status (`past_due`, `unpaid`, `paused`, `incomplete`, ...)
// is inactive. Exported so callers that also need this decision (the
// webhook, re-fetching a subscription itself) share one definition instead
// of re-deriving it.
export function isActiveStatus(status) {
  return status === "active" || status === "trialing";
}

// Applies the asOf-ordering guard and, if it passes, writes
// `{ active, asOf, source, currentPeriodEnd }` to `subStatus:<subscriptionId>`.
// Returns true if the write was applied, false if rejected as stale (asOf <
// the stored entry's asOf) -- a rejection is expected, normal behavior, not
// an error. A thrown error here (an invalid asOf, or a genuine KV read/write
// failure) is meant to propagate: the webhook caller turns a KV failure
// into a 5xx so Stripe retries.
export async function write(env, subscriptionId, { active, asOf, source, currentPeriodEnd = null }) {
  if (typeof asOf !== "number" || !Number.isFinite(asOf)) {
    throw new Error("subStatus.write: asOf must be a finite number");
  }

  const key = kvKey(subscriptionId);
  const raw = await env.STATE_KV.get(key);

  let stored = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.asOf === "number") stored = parsed;
    } catch {
      stored = null; // corrupt entry -- treat as absent, the new write applies
    }
  }

  if (stored && asOf < stored.asOf) {
    return false;
  }

  const options = active ? { expirationTtl: ACTIVE_TTL_SECONDS } : {};
  await env.STATE_KV.put(key, JSON.stringify({ active, asOf, source, currentPeriodEnd }), options);
  return true;
}

// Removes lookupCache entries whose live lookup has already settled and
// whose age is past the dedup window -- an opportunistic O(n) pass (no
// timer) so the map can't grow unboundedly over an isolate's lifetime.
function sweepLookupCache(now) {
  for (const [id, entry] of lookupCache) {
    if (entry.settled && now - entry.checkedAt >= LOOKUP_CACHE_MS) {
      lookupCache.delete(id);
    }
  }
}

// KV-first read with a live-Stripe fallback (through lib/stripe.js), backed
// by the 60s lookup cache described above. Always resolves to
// { active, asOf, source, currentPeriodEnd } -- never throws for a
// subscription that simply doesn't exist at Stripe (404), only for a
// genuine Stripe/network failure (or STRIPE_SECRET_KEY missing, via
// NotConfiguredError), which the caller (entitlement.js) maps to its own
// error response.
export async function read(env, subscriptionId) {
  const key = kvKey(subscriptionId);

  let raw = null;
  try {
    raw = await env.STATE_KV.get(key);
  } catch {
    console.error("substatus_kv_read_failed");
    raw = null; // a cache-read hiccup must not block a legitimate check -- fall through
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.active === "boolean" && typeof parsed.asOf === "number") {
        return { currentPeriodEnd: null, ...parsed };
      }
    } catch {
      // corrupt entry -- fall through to a live lookup
    }
  }

  const now = Date.now();
  sweepLookupCache(now);

  let entry = lookupCache.get(subscriptionId);
  if (!entry || now - entry.checkedAt >= LOOKUP_CACHE_MS) {
    // Stored (and the cache entry set) synchronously, before the first
    // `await` below runs -- so truly concurrent read() calls for the same
    // subscriptionId in this isolate see this entry immediately and share
    // this one in-flight lookup, rather than each starting their own.
    const promise = liveLookup(env, subscriptionId).catch((error) => {
      // Don't let a failure sit in the cache for the rest of the 60s window
      // -- callers after this one should get a fresh attempt. Concurrent
      // callers already awaiting this same promise still all see this
      // rejection, which is the point: a burst during a real Stripe outage
      // still only calls Stripe once, it just isn't cached past that.
      lookupCache.delete(subscriptionId);
      throw error;
    });
    entry = { checkedAt: now, promise, settled: false };
    // Deliberately .then(onFulfilled, onRejected) rather than .finally():
    // both branches only flip a flag and return normally, so this derived
    // promise always resolves and is safe to leave unobserved. A .finally()
    // here would instead re-reject when `promise` does, and since nothing
    // else awaits that specific derived promise, a failed live lookup would
    // surface as an unhandled promise rejection (Node can terminate the
    // process on one) even though the rejection is already properly handled
    // by whoever awaited read() itself.
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      }
    );
    lookupCache.set(subscriptionId, entry);
  }
  return entry.promise;
}

async function liveLookup(env, subscriptionId) {
  if (!env.STRIPE_SECRET_KEY) {
    throw new NotConfiguredError();
  }
  try {
    const subscription = await get(env, `subscriptions/${encodeURIComponent(subscriptionId)}`);
    const item = subscription.items && subscription.items.data[0];
    return {
      active: isActiveStatus(subscription.status),
      asOf: Date.now(),
      source: "live",
      currentPeriodEnd: item ? item.current_period_end : null,
    };
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      return { active: false, asOf: Date.now(), source: "live", currentPeriodEnd: null };
    }
    throw error; // a genuine Stripe/network failure -- let the caller decide the response
  }
}
