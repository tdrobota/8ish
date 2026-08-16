(() => {
  "use strict";

  const QUESTIONS = window.QUESTIONS;
  const CARD_COUNT = 6;

  const startScreen = document.getElementById("start");
  const stageScreen = document.getElementById("stage");
  const startBtn = document.getElementById("startBtn");
  const endBtn = document.getElementById("endBtn");
  const tapLayer = document.getElementById("tapLayer");
  const questionText = document.getElementById("questionText");
  const tapHint = document.getElementById("tapHint");

  // In-memory only (CAP-5 / constraint: nothing about a session is ever persisted).
  let pool = [];
  let cardIndex = 0;
  let firstTapPending = false;

  function shuffled(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function drawNextIndex() {
    if (pool.length === 0) {
      // Pool exhausted (or first draw of a session): reshuffle the full bank.
      // See SPEC.md Assumptions — a single interview is expected to stay well under 200 taps.
      pool = shuffled(QUESTIONS.length);
    }
    return pool.pop();
  }

  function fitText() {
    const cs = getComputedStyle(tapLayer);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const availH = tapLayer.clientHeight - padY;
    const availW = tapLayer.clientWidth - padX;

    // Start big — a generous single-line estimate — then shrink to fit
    // however many lines the wrap needs. Loop only ever shrinks, so the
    // starting guess must already be larger than any question will need.
    let size = availH * 0.75;
    const minSize = 20;
    questionText.style.fontSize = size + "px";

    let guard = 60;
    while (
      guard-- > 0 &&
      size > minSize &&
      (questionText.scrollHeight > availH || questionText.scrollWidth > availW)
    ) {
      size -= Math.max(1, size * 0.04);
      questionText.style.fontSize = size + "px";
    }
  }

  function showNextQuestion() {
    const idx = drawNextIndex();
    questionText.textContent = QUESTIONS[idx];

    cardIndex = (cardIndex + 1) % CARD_COUNT;
    stageScreen.style.background = `var(--card-${cardIndex})`;

    fitText();

    questionText.classList.remove("pop");
    // eslint-disable-next-line no-unused-expressions
    void questionText.offsetWidth; // restart animation
    questionText.classList.add("pop");
  }

  function startSession() {
    pool = [];
    cardIndex = 0;
    firstTapPending = true;

    startScreen.hidden = true;
    stageScreen.hidden = false;
    tapHint.classList.remove("hidden");

    showNextQuestion();
  }

  function endSession() {
    pool = [];
    questionText.textContent = "";
    stageScreen.hidden = true;
    startScreen.hidden = false;
  }

  function handleTap() {
    if (firstTapPending) {
      firstTapPending = false;
      tapHint.classList.add("hidden");
    }
    showNextQuestion();
  }

  startBtn.addEventListener("click", startSession);
  endBtn.addEventListener("click", endSession);
  tapLayer.addEventListener("click", handleTap);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (stageScreen.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitText, 80);
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {
        /* offline capability degrades gracefully without SW */
      });
    });
  }
})();
