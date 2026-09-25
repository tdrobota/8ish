// Shared byte-capped body reader (Story 7-8, extracted from
// functions/api/transform.js's own Story 7-5 implementation, byte-for-byte
// the same logic -- only relocated so every POST endpoint in this app can
// share one copy instead of each hand-rolling its own).
//
// Reads `request.body` via its own reader, accumulating actual bytes and
// aborting (cancelling the stream) the instant the running total exceeds
// `maxBytes`. `Content-Length` is never consulted anywhere in this file --
// it can be absent or wrong, so only bytes actually read ever count.
// Returns `{ok:false}` on either an over-cap body or a genuine stream read
// error; `{ok:true, bytes}` otherwise. A request with no body stream at all
// is treated as zero bytes -- a JSON parse (or whatever the caller does
// next) rejects that on its own, no special-casing needed here.
export async function readCappedBody(request, maxBytes) {
  const body = request.body;
  if (!body || typeof body.getReader !== "function") {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort only -- the over-cap verdict below is what matters.
        }
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
