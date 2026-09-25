// Desenează (draw) mode — Story 1.2 (canvas capture) + Story 1.5 (transform
// submit/result). Independent module: depends only on ui.js (QCUI) and
// prompts.js (window.DRAW_PROMPTS). Never touches app.js or its state. The
// only network call is the POST to /api/transform below; the captured
// sketch itself is otherwise held in memory only.
(() => {
  "use strict";

  const DRAW_PROMPTS = window.DRAW_PROMPTS;
  const STROKE_WIDTH = 7; // fixed, CSS px (canvas is scaled by devicePixelRatio)
  const STROKE_COLOR = "#16171d"; // --ink
  const CANVAS_BG = "#ffffff";

  const drawPromptScreen = document.getElementById("drawPrompt");
  const drawCanvasScreen = document.getElementById("drawCanvas");
  const drawResultScreen = document.getElementById("drawResult");
  QCUI.registerScreen("drawPrompt", drawPromptScreen);
  QCUI.registerScreen("drawCanvas", drawCanvasScreen);
  QCUI.registerScreen("drawResult", drawResultScreen);

  const startDrawBtn = document.getElementById("startDrawBtn");
  const drawPromptText = document.getElementById("drawPromptText");
  const drawPromptBackBtn = document.getElementById("drawPromptBackBtn");
  const drawStartBtn = document.getElementById("drawStartBtn");
  const drawPromptRerollBtn = document.getElementById("drawPromptRerollBtn");

  const drawEndBtn = document.getElementById("drawEndBtn");
  const drawClearBtn = document.getElementById("drawClearBtn");
  const drawFinishBtn = document.getElementById("drawFinishBtn");
  const drawCanvasPrompt = document.getElementById("drawCanvasPrompt");
  const drawSurface = document.getElementById("drawSurface");
  const drawCtx = drawSurface.getContext("2d");

  const drawResultEndBtn = document.getElementById("drawResultEndBtn");
  const drawWaiting = document.getElementById("drawWaiting");
  const drawSuccess = document.getElementById("drawSuccess");
  const drawError = document.getElementById("drawError");
  const drawArtWrap = document.getElementById("drawArtWrap");
  const drawResultMainImg = document.getElementById("drawResultMainImg");
  const drawToggleBtn = document.getElementById("drawToggleBtn");
  const drawToggleThumb = document.getElementById("drawToggleThumb");
  const drawNewBtn = document.getElementById("drawNewBtn");
  const drawSaveBtn = document.getElementById("drawSaveBtn");
  const drawErrorMessage = document.getElementById("drawErrorMessage");
  const drawRetryBtn = document.getElementById("drawRetryBtn");

  // Kid-friendly copy per server response code (Story 7.7 Design Notes), via
  // i18n.js -- keyed by the response body's own error.code, not by HTTP
  // status (a 429 alone covers three different codes that need different
  // messages: daily_limit/wait/rate_limited). provider_error/timeout/
  // human_check_failed/rate_limited all fold into the same generic
  // "try again" bucket (the frozen spec's own resolved decision for
  // rate_limited, which epics.md's AC doesn't name explicitly); a rejected
  // fetch itself is "offline"; any other/unrecognized code (unauthorized,
  // bad_request, not_configured, a malformed 200, ...) falls back to the
  // same generic bucket via finishFailure()'s own `|| ...provider_error`.
  const RESULT_MESSAGE_KEYS = {
    daily_limit: "drawDailyLimit",
    wait: "drawWait",
    resting: "drawResting",
    provider_error: "drawProviderError",
    timeout: "drawProviderError",
    human_check_failed: "drawProviderError",
    rate_limited: "drawProviderError",
    offline: "drawOffline",
  };

  // In-memory only (mirrors app.js's session state: nothing here is ever persisted).
  let pool = [];
  let currentPrompt = null;
  let locked = false; // Termină! was tapped; canvas no longer drawable
  let hasStrokes = false; // at least one stroke drawn this attempt (guards resize-repaint safety)
  let isDrawing = false;
  let lastPoint = null;
  let activePointerId = null; // the single pointer currently drawing; ignore all others
  let capturedImage = null; // { dataUrl, width, height }, ≤512×512, in memory only
  let renderedImageDataUrl = null; // data: URL built from the successful transform response
  let showingSketch = false; // drawResult success view: rendered art (false) vs. sketch (true)
  let inFlight = false; // a /api/transform request is currently pending
  let requestToken = 0; // bumped whenever the flow is abandoned, to drop stale in-flight responses
  // Story 7.7: the promise enterDrawCanvas() started by calling
  // window.LIMIT.getHumanToken("image") once, held here for submitTransform()
  // to await -- never re-awaited a second time (a Turnstile token is
  // single-use), see submitTransform()'s own comment.
  let humanTokenPromise = null;
  let waitCountdownTimer = null; // the "wait" result's live {seconds} countdown, cleared on cleanup

  // --- Prompt pool: same shuffle/pool pattern as app.js's drawNextIndex ---

  function shuffled(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function nextPrompt() {
    if (pool.length === 0) {
      // Pool exhausted (or first draw of a session): reshuffle the full bank.
      pool = shuffled(DRAW_PROMPTS.length);
    }
    return DRAW_PROMPTS[pool.pop()];
  }

  // --- Canvas sizing --------------------------------------------------

  // Only ever called while the canvas has no strokes yet (pre-drawing), so
  // resizing never rescales the kid's live drawing mid-session.
  function sizeCanvas() {
    const wrap = drawSurface.parentElement;
    const cssSize = Math.max(1, Math.min(wrap.clientWidth, wrap.clientHeight));
    const dpr = window.devicePixelRatio || 1;
    drawSurface.style.width = cssSize + "px";
    drawSurface.style.height = cssSize + "px";
    drawSurface.width = Math.round(cssSize * dpr);
    drawSurface.height = Math.round(cssSize * dpr);
    drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paintBackground(cssSize, cssSize);
    applyStrokeStyle();
  }

  function paintBackground(cssW, cssH) {
    drawCtx.save();
    drawCtx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    drawCtx.fillStyle = CANVAS_BG;
    drawCtx.fillRect(0, 0, cssW, cssH);
    drawCtx.restore();
  }

  function applyStrokeStyle() {
    drawCtx.strokeStyle = STROKE_COLOR;
    drawCtx.lineWidth = STROKE_WIDTH;
    drawCtx.lineCap = "round";
    drawCtx.lineJoin = "round";
  }

  function clearCanvas() {
    const cssW = parseFloat(drawSurface.style.width) || drawSurface.width;
    const cssH = parseFloat(drawSurface.style.height) || drawSurface.height;
    paintBackground(cssW, cssH);
    applyStrokeStyle();
  }

  // --- Drawing/interaction state ---------------------------------------

  function setDrawable(enabled) {
    drawSurface.style.cursor = enabled ? "crosshair" : "not-allowed";
  }

  function setClearEnabled(enabled) {
    drawClearBtn.disabled = !enabled;
  }

  function pointFromEvent(event) {
    const rect = drawSurface.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event) {
    if (locked) return;
    // Ignore a second concurrent pointerdown (e.g. a resting palm) while one
    // pointer is already drawing — only the first pointer gets to draw.
    if (isDrawing) return;
    isDrawing = true;
    hasStrokes = true; // canvas is no longer guaranteed blank — resize must stop repainting it
    activePointerId = event.pointerId;
    lastPoint = pointFromEvent(event);
    if (drawSurface.setPointerCapture) {
      try {
        drawSurface.setPointerCapture(event.pointerId);
      } catch (e) {
        /* ignore capture failures */
      }
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (locked || !isDrawing) return;
    if (event.pointerId !== activePointerId) return;
    const point = pointFromEvent(event);
    drawCtx.beginPath();
    drawCtx.moveTo(lastPoint.x, lastPoint.y);
    drawCtx.lineTo(point.x, point.y);
    drawCtx.stroke();
    lastPoint = point;
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (event.pointerId !== activePointerId) return;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    if (drawSurface.hasPointerCapture && drawSurface.hasPointerCapture(event.pointerId)) {
      drawSurface.releasePointerCapture(event.pointerId);
    }
  }

  drawSurface.addEventListener("pointerdown", onPointerDown);
  drawSurface.addEventListener("pointermove", onPointerMove);
  drawSurface.addEventListener("pointerup", onPointerUp);
  drawSurface.addEventListener("pointercancel", onPointerUp);
  drawSurface.addEventListener("pointerleave", onPointerUp);

  // --- Capture (Design Notes: downscale via an off-screen canvas; never
  // resize the live drawing canvas itself) ---------------------------

  function captureDownscaled() {
    try {
      const w = drawSurface.width;
      const h = drawSurface.height;
      const scale = Math.min(1, 512 / Math.max(w, h));
      const out = document.createElement("canvas");
      out.width = Math.round(w * scale);
      out.height = Math.round(h * scale);
      out.getContext("2d").drawImage(drawSurface, 0, 0, out.width, out.height);
      return {
        dataUrl: out.toDataURL("image/png"),
        width: out.width,
        height: out.height,
      };
    } catch (e) {
      console.error("QCDraw: captureDownscaled failed", e);
      return null;
    }
  }

  // The kid taps "Termină!" whenever they consider the drawing done — there
  // is no timer to run out anymore (removed: kids weren't able to finish in
  // the old fixed 30s window, and this button was already the intended way
  // to submit early, so it's now the ONLY way to finish). `locked` guards
  // against a double-tap firing this twice while the screen is transitioning.
  function finishDrawing() {
    if (locked) return;
    locked = true;
    isDrawing = false;
    clearTimeout(resizeTimer); // a stale debounced resize must never fire on a locked canvas
    setDrawable(false);
    setClearEnabled(false);
    capturedImage = captureDownscaled();
    submitTransform();
  }

  // --- Transform submit/result (Story 1.5) --------------------------------

  // capturedImage.dataUrl is always "data:image/png;base64,...." from
  // toDataURL(); AD-6 wants raw base64 with no prefix on the wire.
  function stripDataUrlPrefix(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
  }

  // Story 7.7 (Design Notes): starts (or restarts) the held human-check
  // promise. Called once on entering the canvas screen, and again by
  // submitTransform() itself whenever no promise is currently held (a retry
  // after a failure — a Turnstile token is single-use, so it must be re-run,
  // never reused). window.LIMIT may not exist at all (see this file's header
  // comment) — matches the window.LIMIT && ... pattern used everywhere else
  // here. A rejection (not configured, expired, superseded, ...) resolves to
  // null rather than propagating: the subscriber path never even looks at
  // `turnstile`, and the free-device path already has its own friendly
  // "human_check_failed" -> drawProviderError mapping for a genuinely
  // missing/invalid token.
  function refreshHumanToken() {
    humanTokenPromise = window.LIMIT ? window.LIMIT.getHumanToken("image").catch(() => null) : Promise.resolve(null);
  }

  function clearWaitCountdown() {
    if (waitCountdownTimer) {
      clearInterval(waitCountdownTimer);
      waitCountdownTimer = null;
    }
  }

  function showResultSubState(state) {
    drawWaiting.hidden = state !== "waiting";
    drawSuccess.hidden = state !== "success";
    drawError.hidden = state !== "error";
  }

  function updateResultImages() {
    const sketchUrl = capturedImage ? capturedImage.dataUrl : "";
    if (showingSketch) {
      drawResultMainImg.src = sketchUrl;
      drawResultMainImg.alt = window.I18N.t("drawOriginalAlt");
      drawToggleThumb.src = renderedImageDataUrl || "";
      drawToggleBtn.setAttribute("aria-label", window.I18N.t("showArtworkAria"));
    } else {
      drawResultMainImg.src = renderedImageDataUrl || "";
      drawResultMainImg.alt = window.I18N.t("drawArtworkAlt");
      drawToggleThumb.src = sketchUrl;
      drawToggleBtn.setAttribute("aria-label", window.I18N.t("showOriginalAria"));
    }
  }

  // The AI model doesn't reliably return a square image (unlike the sketch,
  // which is always square — see captureDownscaled). A fixed square frame
  // meant either cropping it (object-fit: cover) or leaving unused space
  // around it (contain). Instead, size the frame to whichever image is
  // currently shown once its real dimensions are known, so "contain" always
  // fills it exactly — no crop, no dead space. Ratio is clamped so a wildly
  // non-square result can't blow up the layout; contain still shows the
  // whole image in that rare case, just with a little letterboxing.
  drawResultMainImg.addEventListener("load", () => {
    const { naturalWidth: w, naturalHeight: h } = drawResultMainImg;
    if (!w || !h) return;
    drawArtWrap.style.aspectRatio = String(Math.min(2, Math.max(0.5, w / h)));
  });

  function finishSuccess(base64Image) {
    renderedImageDataUrl = "data:image/png;base64," + base64Image;
    showingSketch = false;
    updateResultImages();
    showResultSubState("success");
    inFlight = false;
    drawRetryBtn.disabled = false;
  }

  // Synchronous data: URL -> Blob decode. Deliberately not fetch()-based:
  // an `await` between the tap and navigator.share() drops iOS Safari's
  // user-activation flag, silently no-op-ing both share() and the
  // window.open() fallback (reported: worked on Android, did nothing on
  // iOS). Decoding synchronously keeps share() in the same task as the tap.
  function dataUrlToBlob(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    const meta = dataUrl.slice(5, commaIndex); // e.g. "image/png;base64"
    const mime = meta.split(";")[0] || "image/png";
    const binary = atob(dataUrl.slice(commaIndex + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  // CAP-8: save via the native share sheet (Web Share API with a file),
  // not an <a download> link — iOS Safari doesn't reliably turn a download
  // link into "Save Image" the way the share sheet does. Saves whatever is
  // currently shown (rendered art or, if toggled, the original sketch).
  function saveCurrentImage() {
    const dataUrl = drawResultMainImg.src;
    if (!dataUrl || !dataUrl.startsWith("data:")) return; // unset <img>.src resolves to the document's own URL, not "" — guard explicitly
    try {
      const blob = dataUrlToBlob(dataUrl);
      const file = new File([blob], "opera-mea.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file] }).catch((e) => {
          // AbortError from a cancelled share sheet is expected/silent;
          // anything else is logged but never surfaced as an error screen —
          // saving is a side action, its failure shouldn't disrupt the
          // result the kid already has.
          if (e.name !== "AbortError") console.error("QCDraw: save failed", e);
        });
      } else {
        // Fallback for browsers without the file-share API: open the image
        // full-screen so it can at least be long-press-saved manually.
        window.open(dataUrl, "_blank");
      }
    } catch (e) {
      console.error("QCDraw: save failed", e);
    }
  }

  // Story 7.7 (Design Notes): a short countdown from the server's own
  // retryAfterSeconds, ticking down once a second via drawWait's {seconds}
  // placeholder; the retry button stays disabled until it reaches 0, then
  // re-enables — "a short countdown, then the retry button becomes usable
  // again". Cleared by clearWaitCountdown() on cleanup/screen-exit/a new
  // submit (see exitToStart/enterDrawPrompt/submitTransform).
  function startWaitCountdown(seconds) {
    let remaining = Math.max(1, Math.ceil(typeof seconds === "number" && seconds > 0 ? seconds : 1));
    const render = () => {
      drawErrorMessage.textContent = window.I18N.t("drawWait").replace("{seconds}", String(remaining));
    };
    showResultSubState("error");
    inFlight = false;
    drawRetryBtn.disabled = true;
    render();
    waitCountdownTimer = setInterval(() => {
      remaining -= 1;
      render();
      if (remaining <= 0) {
        clearWaitCountdown();
        drawRetryBtn.disabled = false;
      }
    }, 1000);
  }

  // Story 8-2: a fire-and-forget, best-effort funnel signal -- never
  // awaited, never surfacing a failure to the child, never blocking or
  // gating the screen transition it accompanies. keepalive lets the
  // request survive this function returning (and any screen change that
  // follows) immediately after. A rejected fetch (offline, etc.) is
  // swallowed silently -- this counter is read once a day by the owner,
  // not a signal the child's experience can ever depend on.
  function reportEvent(eventName) {
    fetch("/api/e", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: eventName }),
      keepalive: true,
    }).catch(() => {});
  }

  // `extra.seconds` only matters for kind === "wait" (retryAfterSeconds from
  // the response); every other kind ignores it.
  function finishFailure(kind, extra) {
    clearWaitCountdown();
    if (kind === "wait") {
      startWaitCountdown(extra && extra.seconds);
      return;
    }
    // Story 8-2: fired right where the done-for-today state is actually
    // shown to the child -- "daily_limit" is the one denial code that maps
    // to drawDailyLimit (see RESULT_MESSAGE_KEYS above).
    if (kind === "daily_limit") reportEvent("limit_reached");
    drawErrorMessage.textContent = window.I18N.t(RESULT_MESSAGE_KEYS[kind] || RESULT_MESSAGE_KEYS.provider_error);
    showResultSubState("error");
    inFlight = false;
    drawRetryBtn.disabled = false;
  }

  // POSTs the already-captured sketch to /api/transform (Story 7.7's real
  // contract: {sketch, promptId}, auth from window.LIMIT.getAuth(), a
  // Turnstile token from the human check enterDrawCanvas() started) and
  // routes the response to the success/error sub-state, keyed by the JSON
  // body's own error.code (never inferred from HTTP status alone — a 429
  // alone covers three different codes needing three different messages).
  // Re-invoked as-is by retry (same captured sketch, no new capture) and is
  // a no-op while a request is already pending.
  async function submitTransform() {
    if (inFlight) return;
    if (!capturedImage || !capturedImage.dataUrl) {
      console.error("QCDraw: submitTransform called with no captured sketch");
      return;
    }
    inFlight = true;
    drawRetryBtn.disabled = true;
    clearWaitCountdown();
    const token = requestToken;
    showResultSubState("waiting");
    QCUI.showScreen("drawResult");

    // Await the promise enterDrawCanvas() already started (usually already
    // resolved by now — see this file's Design Notes comment on
    // refreshHumanToken), or start a fresh one if none is pending (a retry:
    // the previous attempt already consumed its own token, single-use).
    if (!humanTokenPromise) refreshHumanToken();
    const pendingHumanToken = humanTokenPromise;
    humanTokenPromise = null; // consumed — a later retry must start fresh
    const turnstileToken = await pendingHumanToken;

    // The kid navigated away (Gata / Desen nou) while the human check was
    // still settling — drop this attempt; the navigating action already
    // reset flow state.
    if (token !== requestToken) return;

    // getAuth() returns {authorization} or {device}, never both — `device`
    // maps to the X-Device-Token header, `authorization` is already the
    // exact header name fetch wants (see transform.js's own contract).
    const auth = window.LIMIT ? window.LIMIT.getAuth() : {};
    const headers = { "content-type": "application/json" };
    if (auth.authorization) headers.authorization = auth.authorization;
    if (auth.device) headers["X-Device-Token"] = auth.device;

    const requestBody = {
      sketch: stripDataUrlPrefix(capturedImage.dataUrl),
      promptId: currentPrompt.id,
    };
    if (turnstileToken) requestBody.turnstile = turnstileToken;

    let response;
    try {
      response = await fetch("/api/transform", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (e) {
      // Offline / network failure: the fetch call itself rejected.
      if (token === requestToken) finishFailure("offline");
      return;
    }

    // The kid navigated away (Gata / Desen nou) while this was in flight —
    // drop the response; the navigating action already reset flow state.
    if (token !== requestToken) return;

    let body = null;
    try {
      body = await response.json();
    } catch (e) {
      body = null;
    }
    if (token !== requestToken) return;

    if (response.status === 200) {
      // A successful free-device response carries a device token (a fresh
      // mint, or an echoed existing one) — persist it for next time.
      if (body && typeof body.device === "string" && body.device && window.LIMIT) {
        window.LIMIT.setDevice(body.device);
      }
      if (body && typeof body.image === "string" && body.image.length > 0) {
        finishSuccess(body.image);
      } else {
        finishFailure("provider_error");
      }
      return;
    }

    const code = body && body.error && typeof body.error.code === "string" ? body.error.code : null;
    if (code === "wait") {
      finishFailure("wait", { seconds: body.error.retryAfterSeconds });
    } else {
      finishFailure(code);
    }
  }

  // --- Screen flow -------------------------------------------------------

  function enterDrawPrompt() {
    if (window.LIMIT && !window.LIMIT.tryConsume()) {
      window.LIMIT.showDailyLimit();
      return;
    }

    // Abandon any in-flight/previous transform flow when starting fresh —
    // matches "no continuous draw loop" resolution (Story 1.2 deferred finding).
    requestToken += 1;
    inFlight = false;
    drawRetryBtn.disabled = false;
    clearWaitCountdown();
    humanTokenPromise = null;
    capturedImage = null;
    renderedImageDataUrl = null;
    showingSketch = false;
    currentPrompt = nextPrompt();
    drawPromptText.textContent = currentPrompt.text;
    QCUI.showScreen("drawPrompt");
  }

  // Kid doesn't like/understand the current challenge: swap it for another
  // one without leaving the prompt screen. Draws from the same pool as
  // nextPrompt (no repeats until the 200-prompt bank is exhausted).
  function rerollPrompt() {
    currentPrompt = nextPrompt();
    drawPromptText.textContent = currentPrompt.text;
  }

  function enterDrawCanvas() {
    locked = false;
    hasStrokes = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    capturedImage = null;
    drawCanvasPrompt.textContent = currentPrompt.text;

    QCUI.showScreen("drawCanvas");
    sizeCanvas();
    setDrawable(true);
    setClearEnabled(true);

    // Story 7.7 (Design Notes): runs once on entering the canvas screen, not
    // lazily at submit time, so it usually resolves before the kid even
    // finishes drawing.
    refreshHumanToken();
  }

  function exitToStart() {
    requestToken += 1; // drop any in-flight transform response
    inFlight = false;
    drawRetryBtn.disabled = false;
    clearWaitCountdown();
    humanTokenPromise = null;
    locked = false;
    hasStrokes = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    capturedImage = null;
    renderedImageDataUrl = null;
    showingSketch = false;
    clearTimeout(resizeTimer); // leaving the screen: a pending resize must not fire later
    QCUI.showScreen("start");
  }

  startDrawBtn.addEventListener("click", enterDrawPrompt);
  drawPromptBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  drawStartBtn.addEventListener("click", enterDrawCanvas);
  drawPromptRerollBtn.addEventListener("click", rerollPrompt);
  drawEndBtn.addEventListener("click", exitToStart);
  drawResultEndBtn.addEventListener("click", exitToStart);

  drawToggleBtn.addEventListener("click", () => {
    showingSketch = !showingSketch;
    updateResultImages();
  });

  drawRetryBtn.addEventListener("click", () => {
    // submitTransform() is itself a no-op while inFlight, satisfying
    // "retry is inert while a request is already pending".
    submitTransform();
  });

  drawNewBtn.addEventListener("click", enterDrawPrompt);
  drawSaveBtn.addEventListener("click", saveCurrentImage);

  drawClearBtn.addEventListener("click", () => {
    if (locked) return; // clear is active throughout drawing, not once Termină! has locked the canvas
    clearCanvas();
    hasStrokes = false; // canvas is blank again — resize may safely repaint it once more
  });

  drawFinishBtn.addEventListener("click", finishDrawing);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (drawCanvasScreen.hidden || hasStrokes || locked) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Re-check: sizeCanvas() repaints to a blank background and is only
      // safe while the canvas is still genuinely blank. The guard above only
      // holds at event time, not 80ms later — a resize that lands right as
      // the kid's first stroke begins could otherwise wipe it.
      if (drawCanvasScreen.hidden || hasStrokes || locked) return;
      sizeCanvas();
    }, 80);
  });

  // Debug/verification hook only.
  window.QCDraw = {
    getCapture: () => capturedImage,
    isInFlight: () => inFlight,
  };
})();
