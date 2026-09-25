// Test-only adapter: adapts `node:sqlite`'s `DatabaseSync` to the same
// small `{ exec(query, ...bindings) -> { rows, changes } }` shape
// functions/lib/governor-core.js expects from the real DO SQLite API (see
// that file's own header, and functions/governor.js's `wrapDurableObjectSql`
// for the real-backend equivalent). This file intentionally lives under
// test/, not functions/lib/ -- governor-core.js itself must stay runnable
// inside the Workers runtime too, where `node:sqlite` does not exist, so
// nothing under functions/ may import it at module scope.
//
// `DatabaseSync.prepare(sql).all(...params)` (reads) vs `.run(...params)`
// (writes) is Node's own split -- this adapter picks the right one from the
// query's leading keyword so every call site in governor-core.js can just
// say `sql.exec(query, ...params)` without knowing which backend it's
// talking to, exactly as the spec's Design Notes describe ("a thin shim,
// not a rewrite").

import { DatabaseSync } from "node:sqlite";

const READ_KEYWORDS = new Set(["SELECT", "PRAGMA"]);

export function createSqliteAdapter() {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    exec(query, ...params) {
      const keyword = query.trim().split(/\s+/, 1)[0].toUpperCase();
      const stmt = db.prepare(query);
      if (READ_KEYWORDS.has(keyword)) {
        return { rows: stmt.all(...params), changes: 0 };
      }
      const info = stmt.run(...params);
      return { rows: [], changes: info.changes };
    },
  };
}
