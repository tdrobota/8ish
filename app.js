(() => {
  "use strict";

  const QUESTIONS = window.QUESTIONS;
  const CHALLENGES = window.CHALLENGES;
  const GAMES = window.GAMES;
  const CARD_COUNT = 6;

  const startScreen = document.getElementById("start");
  const stageScreen = document.getElementById("stage");
  const gamesListScreen = document.getElementById("gamesList");
  const gameDetailScreen = document.getElementById("gameDetail");
  QCUI.registerScreen("start", startScreen);
  QCUI.registerScreen("stage", stageScreen);
  QCUI.registerScreen("gamesList", gamesListScreen);
  QCUI.registerScreen("gameDetail", gameDetailScreen);
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

  function renderGamesList() {
    gameGrid.textContent = "";
    GAMES.forEach((game, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "game-card";

      const badge = document.createElement("span");
      badge.className = "game-card-icon";
      badge.style.background = `var(--card-${index % CARD_COUNT})`;
      badge.appendChild(QCUI.iconEl(game.icon));

      const name = document.createElement("p");
      name.className = "game-card-name";
      name.textContent = game.name;

      card.appendChild(badge);
      card.appendChild(name);
      card.addEventListener("click", () => {
        renderGameDetail(game, index);
        QCUI.showScreen("gameDetail");
      });

      gameGrid.appendChild(card);
    });
  }

  function renderGameDetail(game, index) {
    gameDetailBadge.textContent = "";
    gameDetailBadge.style.background = `var(--card-${index % CARD_COUNT})`;
    gameDetailBadge.appendChild(QCUI.iconEl(game.icon));
    gameDetailName.textContent = game.name;
    gameDetailPlayers.textContent = game.players;
    gameDetailDescription.textContent = game.description;

    gameDetailSteps.textContent = "";
    game.steps.forEach((step) => {
      const li = document.createElement("li");
      li.className = "step-row";

      const iconWrap = document.createElement("span");
      iconWrap.className = "step-icon";
      iconWrap.appendChild(QCUI.iconEl(step.icon));

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

  const ring = QCUI.createCountdownRing({
    ringButton: timerRing,
    ringFg: timerRingFg,
    number: timerNumber,
  });

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
    ring.reset();

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
      ring.setIdle(seconds);
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

    QCUI.showScreen("stage");
    tapHint.classList.remove("hidden");

    showNextQuestion();
  }

  function endSession() {
    ring.reset();
    pool = [];
    questionText.textContent = "";
    timerRing.hidden = true;
    QCUI.showScreen("start");
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
    QCUI.showScreen("gamesList");
  });
  gamesBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  gameDetailBackBtn.addEventListener("click", () => QCUI.showScreen("gamesList"));
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
    ring.start();
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
