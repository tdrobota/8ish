// Transform Proxy — Cloudflare Pages Function for POST /api/transform
//
// Takes a locked sketch (raw base64 PNG, no "data:" prefix) plus a prompt,
// runs it through the Workers AI image-edit model via the `env.AI` binding,
// and returns the rendered image as raw base64 PNG.
//
// This is the sole file in the repo that references `context.env.AI` — no
// provider API key or SDK is used anywhere; the binding is billed to the
// Cloudflare account directly (dashboard-configured, see architecture AD-9).

const MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";
const TIMEOUT_MS = 30000;

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function base64ToBlob(base64, contentType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

// Defensively strip a "data:...;base64," prefix, since AD-6 forbids one in
// the response even if the model happens to include it.
function stripDataUriPrefix(value) {
  const match = /^data:[^;]*;base64,(.*)$/s.exec(value);
  return match ? match[1] : value;
}

function raceWithTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function onRequestPost(context) {
  try {
    const { image, prompt } = await context.request.json();

    const imageBlob = base64ToBlob(image, "image/png");
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("input_image_0", imageBlob);

    // Cloudflare's documented trick for turning a FormData into the raw
    // multipart body + content-type this model family's binding expects.
    const formResponse = new Response(form);

    const runPromise = context.env.AI.run(MODEL_ID, {
      multipart: {
        body: formResponse.body,
        contentType: formResponse.headers.get("content-type"),
      },
    });

    const result = await raceWithTimeout(runPromise, TIMEOUT_MS);

    if (typeof result?.image !== "string" || result.image.length === 0) {
      return jsonResponse(502, {
        error: {
          code: "provider_error",
          message: "empty or malformed model response",
        },
      });
    }

    return jsonResponse(200, { image: stripDataUriPrefix(result.image) });
  } catch (error) {
    console.error("Transform Proxy error:", error);
    if (error instanceof TimeoutError) {
      return jsonResponse(504, { error: { code: "timeout" } });
    }
    return jsonResponse(502, {
      error: { code: "provider_error", message: String(error) },
    });
  }
}
