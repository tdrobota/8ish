// The `Governor` Durable Object class (Story 7-2, AD-14/AD-22) -- the one
// place every spend counter in this app lives (epic-7-context.md's own
// Technical Decisions). This file is intentionally almost empty: every real
// decision (the reserve/commit/release state machine, the ceiling count,
// the two clocks, idempotency, the sweep) lives in the pure module
// `functions/lib/governor-core.js`; every piece of alarm-scheduling glue
// that doesn't strictly need a real Durable Object lives in
// `functions/lib/governor-do.js`, which is independently covered by
// `node --test` (see that file's own header for why it's split out this
// way). This file's only job is wiring the real, Cloudflare-specific
// handles -- `ctx.storage.sql`, `ctx.storage` itself, `Date.now` -- into
// `createGovernorHandlers`, and exposing its four operations as methods a
// Durable Object stub can call.
//
// File location (Spec Change Log): the spec's own Code Map suggested
// either `functions/governor.js` (repo root, matching epics.md's literal
// `governor.js` naming) or `functions/lib/`. This repo's `wrangler.jsonc`
// has `"main": "worker.js"` at the repo root -- a single-entry-point plain
// Worker (not classic Pages), so wrangler resolves a Durable Object
// binding's `class_name` against whatever the bundled entry module (i.e.
// `worker.js` and everything it imports) ends up exporting. `functions/
// governor.js` is imported and re-exported by `worker.js` (`export {
// Governor } from "./functions/governor.js"`), which puts `Governor` in
// that bundle's export set -- this is the "a file it imports and
// re-exports" shape the story's own instructions anticipated, confirmed
// against Cloudflare's current Durable Objects documentation and this
// repo's installed wrangler's own config schema (see the spec's Spec
// Change Log for the sources checked). `functions/lib/` was rejected
// purely as a naming/discoverability choice: every other file under
// `functions/lib/` is a shared helper imported by multiple endpoints,
// never a class exported to `wrangler.jsonc` itself, so keeping the actual
// DO class at `functions/governor.js` (parallel to `functions/api/*.js`)
// keeps that distinction visible at a glance.
//
// `reserve`/`commit`/`release` are exposed as plain async methods (RPC-style,
// via extending `DurableObject` from `cloudflare:workers`) rather than a
// `fetch()` handler -- no caller in this story invokes them yet (that's
// Story 7.5); RPC methods are what epic-7-context.md's own Interface
// section describes (`reserve(kind, key, cfg)`, `commit(id)`,
// `release(id, {...})` as direct calls, not as a request/response shape).

import { DurableObject } from "cloudflare:workers";
import { createGovernorHandlers } from "./lib/governor-do.js";

// Adapts the real DO SQLite API (`ctx.storage.sql.exec(query, ...bindings)`,
// returning a cursor with `.toArray()` and `.rowsWritten`) to the small
// synchronous `{ exec(query, ...bindings) -> { rows, changes } }` shape
// `governor-core.js` expects. Per Cloudflare's Storage API docs, the cursor
// must be fully consumed (here, via `.toArray()`) before any subsequent
// `await` to preserve snapshot isolation -- every call site in
// governor-core.js does exactly that (no `await` appears between an
// `sql.exec(...)` call and its result being used).
function wrapDurableObjectSql(storageSql) {
  return {
    exec(query, ...bindings) {
      const cursor = storageSql.exec(query, ...bindings);
      const rows = cursor.toArray();
      return { rows, changes: cursor.rowsWritten };
    },
  };
}

export class Governor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.handlers = createGovernorHandlers({
      sql: wrapDurableObjectSql(ctx.storage.sql),
      now: () => Date.now(),
      storage: ctx.storage,
    });
  }

  async reserve(kind, key, cfg) {
    return this.handlers.reserve(kind, key, cfg);
  }

  async commit(id) {
    return this.handlers.commit(id);
  }

  async release(id, opts) {
    return this.handlers.release(id, opts);
  }

  // Story 8-4: one new additive, read-only RPC method -- mirrors
  // commit()/release()'s own one-line delegation shape. Used only by
  // functions/lib/rollup.js's buildRollup() (via worker.js's scheduled()
  // handler and scripts/backfill-rollup.mjs), never by the reserve/commit/
  // release spend path itself.
  async getDailyImageCounts(budgetDay) {
    return this.handlers.getDailyImageCounts(budgetDay);
  }

  // Cloudflare Durable Object alarms are at-least-once and there is
  // exactly one alarm per DO -- `governor-do.js`'s `alarm()` already
  // guarantees it never throws past this call (it catches, logs, and
  // reschedules internally), but this method still doesn't add its own
  // try/catch on top: doing so would only duplicate that handling, and a
  // truly unexpected throw here (e.g. `this.handlers` itself failed to
  // construct) is exactly the kind of thing that SHOULD surface as a
  // failed alarm delivery for Cloudflare's own at-least-once redelivery to
  // retry, rather than being silently swallowed a second time.
  async alarm() {
    return this.handlers.alarm();
  }
}
