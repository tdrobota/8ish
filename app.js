(() => {
  "use strict";

  const QUESTIONS = window.QUESTIONS;
  const CHALLENGES = window.CHALLENGES;
  const CARD_COUNT = 6;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

  const startScreen = document.getElementById("start");
  const stageScreen = document.getElementById("stage");
  const startQuestionsBtn = document.getElementById("startQuestionsBtn");
  const startChallengesBtn = document.getElementById("startChallengesBtn");
  const endBtn = document.getElementById("endBtn");
  const tapLayer = document.getElementById("tapLayer");
  const cardContent = document.getElementById("cardContent");
  const questionText = document.getElementById("questionText");
  const tapHint = document.getElementById("tapHint");
  const timerRing = document.getElementById("timerRing");
  const timerRingFg = document.getElementById("timerRingFg");
  const timerNumber = document.getElementById("timerNumber");

  // In-memory only (CAP-5 / constraint: nothing about a session is ever persisted).
  let mode = "questions"; // "questions" | "challenges"
  let pool = [];
  let cardIndex = 0;
  let firstTapPending = false;
  let timerInterval = null;

  function currentBank() {
    return mode === "challenges" ? CHALLENGES : QUESTIONS;
  }

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
      pool = shuffled(currentBank().length);
    }
    return pool.pop();
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerRingFg.style.transition = "none";
    timerRingFg.style.strokeDashoffset = "0";
    timerNumber.classList.remove("timer-done");
  }

  function startTimer(seconds) {
    timerNumber.classList.remove("timer-done");
    timerNumber.textContent = String(seconds);
    timerRingFg.style.transition = "none";
    timerRingFg.style.strokeDashoffset = "0";
    // Force reflow so the transition below actually animates from 0.
    void timerRingFg.getBoundingClientRect();
    timerRingFg.style.transition = `stroke-dashoffset ${seconds}s linear`;
    timerRingFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

    let remaining = seconds;
    timerInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timerInterval);
        timerInterval = null;
        timerNumber.textContent = "GATA!";
        timerNumber.classList.add("timer-done");
      } else {
        timerNumber.textContent = String(remaining);
      }
    }, 1000);
  }

  function fitText() {
    const cs = getComputedStyle(tapLayer);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    let availH = tapLayer.clientHeight - padY;
    const availW = tapLayer.clientWidth - padX;

    if (!timerRing.hidden) {
      const gap = parseFloat(getComputedStyle(cardContent).gap) || 0;
      availH -= timerRing.offsetHeight + gap;
    }

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
    stopTimer();

    const bank = currentBank();
    const idx = drawNextIndex();
    const item = bank[idx];
    const isChallenge = mode === "challenges";
    const text = isChallenge ? item.text : item;
    const seconds = isChallenge ? item.seconds : 0;

    questionText.textContent = text;

    cardIndex = (cardIndex + 1) % CARD_COUNT;
    stageScreen.style.background = `var(--card-${cardIndex})`;

    if (seconds > 0) {
      timerRing.hidden = false;
      startTimer(seconds);
    } else {
      timerRing.hidden = true;
    }

    fitText();

    questionText.classList.remove("pop");
    // eslint-disable-next-line no-unused-expressions
    void questionText.offsetWidth; // restart animation
    questionText.classList.add("pop");
  }

  function startSession(selectedMode) {
    mode = selectedMode;
    pool = [];
    cardIndex = 0;
    firstTapPending = true;

    startScreen.hidden = true;
    stageScreen.hidden = false;
    tapHint.classList.remove("hidden");

    showNextQuestion();
  }

  function endSession() {
    stopTimer();
    pool = [];
    questionText.textContent = "";
    timerRing.hidden = true;
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

  startQuestionsBtn.addEventListener("click", () => startSession("questions"));
  startChallengesBtn.addEventListener("click", () => startSession("challenges"));
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
