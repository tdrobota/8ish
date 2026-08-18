(() => {
  "use strict";

  const QUESTIONS = window.QUESTIONS;
  const CHALLENGES = window.CHALLENGES;
  const GAMES = window.GAMES;
  const CARD_COUNT = 6;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const startScreen = document.getElementById("start");
  const stageScreen = document.getElementById("stage");
  const gamesListScreen = document.getElementById("gamesList");
  const gameDetailScreen = document.getElementById("gameDetail");
  const screens = {
    start: startScreen,
    stage: stageScreen,
    gamesList: gamesListScreen,
    gameDetail: gameDetailScreen,
  };
  const startQuestionsBtn = document.getElementById("startQuestionsBtn");
  const startChallengesBtn = document.getElementById("startChallengesBtn");
  const startGamesBtn = document.getElementById("startGamesBtn");
  const gamesBackBtn = document.getElementById("gamesBackBtn");
  const gameDetailBackBtn = document.getElementById("gameDetailBackBtn");
  const gameGrid = document.getElementById("gameGrid");
  const gameDetailBadge = document.getElementById("gameDetailBadge");
  const gameDetailName = document.getElementById("gameDetailName");
  const gameDetailPlayers = document.getElementById("gameDetailPlayers");
  const gameDetailDescription = document.getElementById("gameDetailDescription");
  const gameDetailSteps = document.getElementById("gameDetailSteps");
  const endBtn = document.getElementById("endBtn");
  const tapLayer = document.getElementById("tapLayer");
  const cardContent = document.getElementById("cardContent");
  const questionText = document.getElementById("questionText");
  const tapHint = document.getElementById("tapHint");
  const timerRing = document.getElementById("timerRing");
  const timerRingFg = document.getElementById("timerRingFg");
  const timerNumber = document.getElementById("timerNumber");

  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      screens[key].hidden = key !== name;
    });
  }

  function iconEl(key) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 64 64");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", "#icon-" + key);
    svg.appendChild(use);
    return svg;
  }

  function renderGamesList() {
    gameGrid.textContent = "";
    GAMES.forEach((game, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "game-card";

      const badge = document.createElement("span");
      badge.className = "game-card-icon";
      badge.style.background = `var(--card-${index % CARD_COUNT})`;
      badge.appendChild(iconEl(game.icon));

      const name = document.createElement("p");
      name.className = "game-card-name";
      name.textContent = game.name;

      card.appendChild(badge);
      card.appendChild(name);
      card.addEventListener("click", () => {
        renderGameDetail(game, index);
        showScreen("gameDetail");
      });

      gameGrid.appendChild(card);
    });
  }

  function renderGameDetail(game, index) {
    gameDetailBadge.textContent = "";
    gameDetailBadge.style.background = `var(--card-${index % CARD_COUNT})`;
    gameDetailBadge.appendChild(iconEl(game.icon));
    gameDetailName.textContent = game.name;
    gameDetailPlayers.textContent = game.players;
    gameDetailDescription.textContent = game.description;

    gameDetailSteps.textContent = "";
    game.steps.forEach((step) => {
      const li = document.createElement("li");
      li.className = "step-row";

      const iconWrap = document.createElement("span");
      iconWrap.className = "step-icon";
      iconWrap.appendChild(iconEl(step.icon));

      const text = document.createElement("p");
      text.className = "step-text";
      text.textContent = step.text;

      li.appendChild(iconWrap);
      li.appendChild(text);
      gameDetailSteps.appendChild(li);
    });

    const scrollArea = gameDetailScreen.querySelector(".games-scroll");
    if (scrollArea) scrollArea.scrollTop = 0;
  }

  // In-memory only (CAP-5 / constraint: nothing about a session is ever persisted).
  let mode = "questions"; // "questions" | "challenges"
  let pool = [];
  let cardIndex = 0;
  let firstTapPending = false;
  let timerInterval = null;
  let pendingSeconds = 0; // duration of the current card's timer, until the kid starts it

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

  function resetRingVisual() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    timerRingFg.style.transition = "none";
    timerRingFg.style.strokeDashoffset = "0";
    timerRing.classList.remove("timer-idle");
    timerNumber.classList.remove("timer-label", "timer-done");
    pendingSeconds = 0;
  }

  // Shows the ring full, labeled "START" — the kid taps it to begin the countdown.
  function setTimerIdle(seconds) {
    resetRingVisual();
    pendingSeconds = seconds;
    timerRing.classList.add("timer-idle");
    timerNumber.classList.add("timer-label");
    timerNumber.textContent = "START";
  }

  function startTimer() {
    if (!pendingSeconds || timerInterval) return;
    const seconds = pendingSeconds;
    pendingSeconds = 0;

    timerRing.classList.remove("timer-idle");
    timerNumber.classList.remove("timer-label");
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
        timerNumber.classList.add("timer-label", "timer-done");
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
    resetRingVisual();

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
      setTimerIdle(seconds);
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

    showScreen("stage");
    tapHint.classList.remove("hidden");

    showNextQuestion();
  }

  function endSession() {
    resetRingVisual();
    pool = [];
    questionText.textContent = "";
    timerRing.hidden = true;
    showScreen("start");
  }

  function dismissHint() {
    if (firstTapPending) {
      firstTapPending = false;
      tapHint.classList.add("hidden");
    }
  }

  function handleTap() {
    dismissHint();
    showNextQuestion();
  }

  startQuestionsBtn.addEventListener("click", () => startSession("questions"));
  startChallengesBtn.addEventListener("click", () => startSession("challenges"));
  startGamesBtn.addEventListener("click", () => {
    renderGamesList();
    showScreen("gamesList");
  });
  gamesBackBtn.addEventListener("click", () => showScreen("start"));
  gameDetailBackBtn.addEventListener("click", () => showScreen("gamesList"));
  endBtn.addEventListener("click", endSession);
  tapLayer.addEventListener("click", handleTap);
  tapLayer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleTap();
    }
  });

  timerRing.addEventListener("click", (event) => {
    event.stopPropagation();
    dismissHint();
    startTimer();
  });

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
