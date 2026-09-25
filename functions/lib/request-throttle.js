// Per-isolate request throttle (Story 7-8, spec-7-8-quota-defenses.md's
// Design Notes) -- a cheap first line of defense IN FRONT OF the Governor,
// shared by every credential/device-keyed endpoint that calls it
// (restore.js, transform.js). The Governor's own minGapSec/freeGlobalGapSec/
// daily allowances remain the real, authoritative limits; nothing here
// carries any cross-isolate or cross-restart guarantee -- an isolate can be
// recycled at any time, and a caller must never treat either cache as a
// substitute for the Governor's own accounting.
//
// Two module-level, in-isolate Maps, mirroring lib/subStatus.js's own
// `lookupCache` pattern (module-scope, isolate-lifetime only, read that
// file first):
//
//   denyCache:   key -> { code, retryAfterSeconds, recordedAt }
//     A remembered `wait`/`daily_limit` denial the Governor's own reserve()
//     already returned once. checkDenyCache() answers straight from this
//     for 60s without ever calling the Governor again.
//
//   preLimitWindows: key -> { windowStart, count }
//     A stateless fixed-window counter -- at most MAX_ATTEMPTS_PER_WINDOW
//     attempts per key per PRE_LIMIT_WINDOW_MS. This is NOT a denial record
//     (it never itself becomes a deny-cache entry) -- it only caps how fast
//     a burst that hasn't even earned a real Governor denial yet can reach
//     the Governor at all.
//
// Both maps are capped at MAX_MAP_ENTRIES -- once a map would grow past that
// bound, its single oldest entry (by insertion order, which is also
// Map's own iteration order) is evicted before the new one is added, so an
// attacker rotating through unique keys can't grow either map unboundedly
// within one isolate's lifetime.

const DENY_CACHE_TTL_MS = 60 * 1000;
const PRE_LIMIT_WINDOW_MS = 10 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const PRE_LIMIT_RETRY_AFTER_SECONDS = 5;
const MAX_MAP_ENTRIES = 10000;

const denyCache = new Map();
const preLimitWindows = new Map();

// Evicts the single oldest entry (Map iteration order == insertion order)
// once `map` is about to exceed MAX_MAP_ENTRIES -- called right before a
// NEW key is inserted, never on an update to an existing key (an update
// doesn't grow the map).
function evictOldestIfFull(map, key) {
  if (map.has(key)) return;
  if (map.size >= MAX_MAP_ENTRIES) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

// An unexpired remembered denial for `key`, or `null` if none exists or it
// has aged past its 60s TTL (an expired entry is also removed here, so the
// map doesn't hold stale entries indefinitely between recordDenial() calls).
export function checkDenyCache(key, now = Date.now()) {
  const entry = denyCache.get(key);
  if (!entry) return null;
  if (now - entry.recordedAt >= DENY_CACHE_TTL_MS) {
    denyCache.delete(key);
    return null;
  }
  return { code: entry.code, retryAfterSeconds: entry.retryAfterSeconds };
}

// Records a REAL wait/daily_limit denial the Governor's own reserve() just
// returned, so a repeat for the same key within 60s is answered by
// checkDenyCache() above without a second Governor call. `retryAfterSeconds`
// is optional (daily_limit denials don't carry one) -- stored as `null` when
// absent, matching the Governor's own denial shape.
export function recordDenial(key, { code, retryAfterSeconds = null } = {}, now = Date.now()) {
  evictOldestIfFull(denyCache, key);
  denyCache.set(key, { code, retryAfterSeconds, recordedAt: now });
}

// A simple fixed-window counter: at most MAX_ATTEMPTS_PER_WINDOW attempts
// per key per PRE_LIMIT_WINDOW_MS (10s). Returns true (proceed -- this
// attempt is counted) or false (pre-limited -- deny before the Governor,
// this attempt is still counted so a sustained burst stays capped). A new
// window starts the moment `now` has moved PRE_LIMIT_WINDOW_MS past the
// window's own start, at which point the counter resets to 1 for this call.
export function checkPreLimit(key, now = Date.now()) {
  let entry = preLimitWindows.get(key);
  if (!entry || now - entry.windowStart >= PRE_LIMIT_WINDOW_MS) {
    evictOldestIfFull(preLimitWindows, key);
    entry = { windowStart: now, count: 0 };
    preLimitWindows.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS_PER_WINDOW;
}

// The fixed, small retry hint a pre-limited (not-yet-a-real-denial) request
// gets -- exported so callers don't repeat this literal themselves.
export const PRE_LIMIT_RETRY_AFTER = PRE_LIMIT_RETRY_AFTER_SECONDS;

// Test-only resets -- real callers (a live Worker isolate) never need to
// clear these themselves; a fresh isolate simply starts with empty maps.
export function _resetRequestThrottleForTests() {
  denyCache.clear();
  preLimitWindows.clear();
}
