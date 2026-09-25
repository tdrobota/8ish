// Story 8-3 -- Source Links: GET /<name> for a name in the SOURCE_LINKS
// Worker var writes one funnel counter through Story 8-1's shared writeEvent
// helper (event "source_visit", source the matched name), unchanged, and
// answers 302 to exactly "/" -- hardcoded, never derived from the request,
// closing any open-redirect surface by construction (this story's frozen
// "Always" clause). Any other name, or any method other than GET, falls
// through to worker.js's own existing routes/404; nothing is ever written
// for those.
//
// Name VALIDATION (the ^[a-z0-9-]{2,20}$ regex, and the collision check
// against real top-level public/ asset paths and the reserved names "api"/
// "sw") is deliberately NOT done here, at request time. It is a static,
// pre-deploy check against the committed wrangler.jsonc
// (scripts/check-config.mjs's own Story 8-3 section), per this story's
// frozen spec's "Always" clause: a malformed or colliding SOURCE_LINKS entry
// must be caught before it ever ships, not silently dropped by runtime
// logic. This module simply trusts whatever SOURCE_LINKS the deploy already
// carries -- matching every real name against the actual path, nothing more.
//
// Kept pure and dependency-free -- writeEvent is passed in by the caller
// (worker.js hands it its own real functions/lib/events.js import) rather
// than imported here -- so the whole routing decision is testable under
// plain Node without a real env.FUNNEL binding; see scripts/check-config.mjs.
// The parameter is deliberately still named `writeEvent` (not e.g.
// `writeEventFn`) so the call site below reads, and scans, exactly like
// every other real writeEvent(...) call in this repo -- see
// scripts/check-config.mjs's own repo-wide literal-args-only check, which
// this file's one bounded exception (the `name` argument below) is proven
// against directly.

// Splits SOURCE_LINKS on "," and trims each entry, dropping empty strings.
// An unset/empty var (the committed default, `""`) or stray/doubled commas
// all yield the empty Set, which matches nothing -- every /<name> request
// then falls through to the existing 404, exactly as before this story
// existed.
export function parseSourceLinks(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
  );
}

// The whole request-time decision for one incoming request. Returns a
// Response to send back to the caller (the 302 for a matched Source Link
// visit) or `null` when this request is not a Source Link visit at all --
// in which case worker.js falls through to its own remaining routes/404,
// completely unchanged.
//
// Only GET counts (checked explicitly, not just "GET-only by accident" --
// this story's frozen "Always" clause): a HEAD (or any other method)
// request for a valid name is never matched here at all, so it always falls
// through to the 404, and writeEvent is never called for it.
export function handleSourceLinkRequest(request, env, ctx, writeEvent) {
  if (request.method !== "GET") return null;

  const url = new URL(request.url);
  const name = url.pathname.slice(1);
  const names = parseSourceLinks(env && env.SOURCE_LINKS);
  if (!names.has(name)) return null;

  // `name` reaches writeEvent() as a bare identifier here, but only ever
  // one already proven (by the `names.has(name)` guard just above, which
  // returns early otherwise) to be one of the finite, pre-validated
  // SOURCE_LINKS entries -- never arbitrary request-supplied text.
  writeEvent(env, ctx, "source_visit", name);
  // Hardcoded target, never built from `request`/`url` -- no open-redirect
  // surface, by construction.
  return new Response(null, { status: 302, headers: { Location: "/" } });
}
