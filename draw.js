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

  // Not a real secret (it ships in public client JS) — just filters out
  // generic scanners/bots hitting /api/transform blindly. Must match the
  // literal in functions/api/transform.js.
  const APP_TOKEN = "f73dc90199f1fa117ffc96c2ed278fc6";

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
  const drawTimerRing = document.getElementById("drawTimerRing");
  const drawTimerRingFg = document.getElementById("drawTimerRingFg");
  const drawTimerNumber = document.getElementById("drawTimerNumber");

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

  // Kid-friendly copy per failure kind (Design Notes), via i18n.js. Cooldown
  // maps from a 429; every other non-200 (502/504/anything else) shares the
  // generic provider/timeout message; a rejected fetch itself is "offline".
  const RESULT_MESSAGE_KEYS = {
    cooldown: "drawCooldown",
    provider_error: "drawProviderError",
    offline: "drawOffline",
    ai_limit: "drawAiLimit",
  };

  // In-memory only (mirrors app.js's session state: nothing here is ever persisted).
  let pool = [];
  let currentPrompt = null;
  let started = false; // countdown has been tapped/started
  let locked = false; // timer hit 0; canvas no longer drawable
  let isDrawing = false;
  let lastPoint = null;
  let activePointerId = null; // the single pointer currently drawing; ignore all others
  let capturedImage = null; // { dataUrl, width, height }, ≤512×512, in memory only
  let renderedImageDataUrl = null; // data: URL built from the successful transform response
  let showingSketch = false; // drawResult success view: rendered art (false) vs. sketch (true)
  let inFlight = false; // a /api/transform request is currently pending
  let requestToken = 0; // bumped whenever the flow is abandoned, to drop stale in-flight responses

  const ring = QCUI.createCountdownRing(
    { ringButton: drawTimerRing, ringFg: drawTimerRingFg, number: drawTimerNumber },
    { onComplete: handleComplete }
  );

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
    if (!started || locked) return;
    // Ignore a second concurrent pointerdown (e.g. a resting palm) while one
    // pointer is already drawing — only the first pointer gets to draw.
    if (isDrawing) return;
    isDrawing = true;
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
    if (!started || locked || !isDrawing) return;
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

  function handleComplete() {
    locked = true;
    started = false;
    isDrawing = false;
    clearTimeout(resizeTimer); // a stale debounced resize must never fire on a locked canvas
    setDrawable(false);
    setClearEnabled(false);
    drawFinishBtn.hidden = true;
    capturedImage = captureDownscaled();
    submitTransform();
  }

  // Kid taps "Termină!" before the timer runs out: stop the ring's own
  // interval first (ring.reset(), not letting it reach 0) so its onComplete
  // can't also fire handleComplete a second time, then run the exact same
  // completion path as a natural timeout.
  function finishEarly() {
    if (!started || locked) return;
    ring.reset();
    handleComplete();
  }

  // --- Transform submit/result (Story 1.5) --------------------------------

  // capturedImage.dataUrl is always "data:image/png;base64,...." from
  // toDataURL(); AD-6 wants raw base64 with no prefix on the wire.
  function stripDataUrlPrefix(dataUrl) {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
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

  function finishFailure(kind) {
    drawErrorMessage.textContent = window.I18N.t(RESULT_MESSAGE_KEYS[kind] || RESULT_MESSAGE_KEYS.provider_error);
    showResultSubState("error");
    inFlight = false;
    drawRetryBtn.disabled = false;
  }

  // POSTs the already-captured sketch to /api/transform and routes the
  // response to the success/error sub-state. Re-invoked as-is by retry
  // (same captured sketch, no new capture) and is a no-op while a request
  // is already pending.
  async function submitTransform() {
    if (inFlight) return;
    if (!capturedImage || !capturedImage.dataUrl) {
      console.error("QCDraw: submitTransform called with no captured sketch");
      return;
    }
    if (window.LIMIT && !window.LIMIT.tryConsumeAi()) {
      QCUI.showScreen("drawResult");
      finishFailure("ai_limit");
      return;
    }
    inFlight = true;
    drawRetryBtn.disabled = true;
    const token = requestToken;
    showResultSubState("waiting");
    QCUI.showScreen("drawResult");

    let response;
    try {
      response = await fetch("/api/transform", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-token": APP_TOKEN },
        body: JSON.stringify({
          image: stripDataUrlPrefix(capturedImage.dataUrl),
          prompt: currentPrompt.text,
        }),
      });
    } catch (e) {
      // Offline / network failure: the fetch call itself rejected.
      if (token === requestToken) finishFailure("offline");
      return;
    }

    // The kid navigated away (Gata / Desen nou) while this was in flight —
    // drop the response; the navigating action already reset flow state.
    if (token !== requestToken) return;

    if (response.status === 200) {
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        body = null;
      }
      if (token !== requestToken) return;
      if (body && typeof body.image === "string" && body.image.length > 0) {
        finishSuccess(body.image);
      } else {
        finishFailure("provider_error");
      }
    } else if (response.status === 429) {
      finishFailure("cooldown");
    } else {
      // 502, 504, or anything else unexpected: same generic friendly message.
      finishFailure("provider_error");
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
    started = false;
    locked = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    capturedImage = null;
    drawCanvasPrompt.textContent = currentPrompt.text;
    drawFinishBtn.hidden = true;

    QCUI.showScreen("drawCanvas");
    sizeCanvas();
    setDrawable(false);
    setClearEnabled(true);
    ring.setIdle(currentPrompt.seconds);
  }

  function exitToStart() {
    requestToken += 1; // drop any in-flight transform response
    inFlight = false;
    drawRetryBtn.disabled = false;
    ring.reset();
    started = false;
    locked = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    capturedImage = null;
    renderedImageDataUrl = null;
    showingSketch = false;
    drawFinishBtn.hidden = true;
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
    if (started || locked) return; // clear is only active before the countdown starts
    clearCanvas();
  });

  drawTimerRing.addEventListener("click", (event) => {
    event.stopPropagation();
    if (started || locked) return;
    started = true;
    setDrawable(true);
    setClearEnabled(false);
    drawFinishBtn.hidden = false;
    ring.start();
  });

  drawFinishBtn.addEventListener("click", finishEarly);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (drawCanvasScreen.hidden || started || locked) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Re-check: sizeCanvas() repaints to a blank background and is only
      // safe pre-drawing. The guard above only holds at event time, not 80ms
      // later — a resize that lands right before the kid taps the timer ring
      // to start drawing could otherwise wipe an in-progress sketch.
      if (drawCanvasScreen.hidden || started || locked) return;
      sizeCanvas();
    }, 80);
  });

  // Debug/verification hook only.
  window.QCDraw = {
    getCapture: () => capturedImage,
    isInFlight: () => inFlight,
  };
})();
