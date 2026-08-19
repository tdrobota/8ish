// Desenează (draw) mode — Story 1.2. Independent module: depends only on
// ui.js (QCUI) and prompts.js (window.DRAW_PROMPTS). Never touches app.js or
// its state. No network call in this story — the captured sketch stays in
// memory only.
(() => {
  "use strict";

  const DRAW_PROMPTS = window.DRAW_PROMPTS;
  const STROKE_WIDTH = 7; // fixed, CSS px (canvas is scaled by devicePixelRatio)
  const STROKE_COLOR = "#16171d"; // --ink
  const CANVAS_BG = "#ffffff";

  const drawPromptScreen = document.getElementById("drawPrompt");
  const drawCanvasScreen = document.getElementById("drawCanvas");
  QCUI.registerScreen("drawPrompt", drawPromptScreen);
  QCUI.registerScreen("drawCanvas", drawCanvasScreen);

  const startDrawBtn = document.getElementById("startDrawBtn");
  const drawPromptText = document.getElementById("drawPromptText");
  const drawPromptBackBtn = document.getElementById("drawPromptBackBtn");
  const drawStartBtn = document.getElementById("drawStartBtn");

  const drawEndBtn = document.getElementById("drawEndBtn");
  const drawClearBtn = document.getElementById("drawClearBtn");
  const drawCanvasPrompt = document.getElementById("drawCanvasPrompt");
  const drawSurface = document.getElementById("drawSurface");
  const drawCtx = drawSurface.getContext("2d");
  const drawTimerRing = document.getElementById("drawTimerRing");
  const drawTimerRingFg = document.getElementById("drawTimerRingFg");
  const drawTimerNumber = document.getElementById("drawTimerNumber");

  // In-memory only (mirrors app.js's session state: nothing here is ever persisted).
  let pool = [];
  let currentPrompt = null;
  let started = false; // countdown has been tapped/started
  let locked = false; // timer hit 0; canvas no longer drawable
  let isDrawing = false;
  let lastPoint = null;
  let activePointerId = null; // the single pointer currently drawing; ignore all others
  let capturedImage = null; // { dataUrl, width, height }, ≤512×512, in memory only

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
    capturedImage = captureDownscaled();
  }

  // --- Screen flow -------------------------------------------------------

  function enterDrawPrompt() {
    currentPrompt = nextPrompt();
    drawPromptText.textContent = currentPrompt.text;
    QCUI.showScreen("drawPrompt");
  }

  function enterDrawCanvas() {
    started = false;
    locked = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    capturedImage = null;
    drawCanvasPrompt.textContent = currentPrompt.text;

    QCUI.showScreen("drawCanvas");
    sizeCanvas();
    setDrawable(false);
    setClearEnabled(true);
    ring.setIdle(currentPrompt.seconds);
  }

  function exitToStart() {
    ring.reset();
    started = false;
    locked = false;
    isDrawing = false;
    lastPoint = null;
    activePointerId = null;
    clearTimeout(resizeTimer); // leaving the screen: a pending resize must not fire later
    QCUI.showScreen("start");
  }

  startDrawBtn.addEventListener("click", enterDrawPrompt);
  drawPromptBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  drawStartBtn.addEventListener("click", enterDrawCanvas);
  drawEndBtn.addEventListener("click", exitToStart);

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
    ring.start();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (drawCanvasScreen.hidden || started || locked) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(sizeCanvas, 80);
  });

  // Debug/verification hook only — the capture never leaves memory or this
  // module on its own; nothing here performs a network call.
  window.QCDraw = {
    getCapture: () => capturedImage,
  };
})();
