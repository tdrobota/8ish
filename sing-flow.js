// Cântă (sing) mode — theme + style onboarding, then real lyrics via
// /api/song (Workers AI text model). Independent module: depends only on
// ui.js (QCUI) and sing.js (window.SING_THEMES / window.SING_STYLES).
// Never touches app.js or draw.js state. Song audio is intentionally not
// generated yet (see plan: no official Suno API access) — this flow ends on
// the lyrics with a "coming soon" note.
(() => {
  "use strict";

  const SING_THEMES = window.SING_THEMES;
  const SING_STYLES = window.SING_STYLES;
  const CARD_COUNT = 6;

  // Same non-secret scanner filter as draw.js — must match functions/api/song.js.
  const APP_TOKEN = "f73dc90199f1fa117ffc96c2ed278fc6";

  const startSingBtn = document.getElementById("startSingBtn");

  const singThemeScreen = document.getElementById("singTheme");
  const singStyleScreen = document.getElementById("singStyle");
  const singResultScreen = document.getElementById("singResult");
  QCUI.registerScreen("singTheme", singThemeScreen);
  QCUI.registerScreen("singStyle", singStyleScreen);
  QCUI.registerScreen("singResult", singResultScreen);

  const singThemeBackBtn = document.getElementById("singThemeBackBtn");
  const singThemeGrid = document.getElementById("singThemeGrid");
  const singStyleBackBtn = document.getElementById("singStyleBackBtn");
  const singStyleGrid = document.getElementById("singStyleGrid");

  const singResultEndBtn = document.getElementById("singResultEndBtn");
  const singWaiting = document.getElementById("singWaiting");
  const singSuccess = document.getElementById("singSuccess");
  const singError = document.getElementById("singError");
  const singLyrics = document.getElementById("singLyrics");
  const singNewBtn = document.getElementById("singNewBtn");
  const singErrorMessage = document.getElementById("singErrorMessage");
  const singRetryBtn = document.getElementById("singRetryBtn");

  // Same kid-friendly Romanian copy per failure kind as draw.js.
  const RESULT_MESSAGES = {
    cooldown: "Așteaptă puțin și mai încearcă o dată!",
    provider_error: "Hopa! Ceva nu a mers bine. Mai încearcă!",
    offline: "Ai nevoie de internet ca să scriem cântecul. Încearcă din nou!",
  };

  // In-memory only (mirrors draw.js / app.js: nothing here is ever persisted).
  let chosenTheme = null;
  let chosenStyle = null;
  let inFlight = false;
  let requestToken = 0; // bumped whenever the flow is abandoned, to drop stale in-flight responses

  function renderGrid(container, items, onSelect) {
    container.textContent = "";
    items.forEach((item, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "sing-card";
      card.style.background = `var(--card-${index % CARD_COUNT})`;

      const label = document.createElement("p");
      label.className = "sing-card-label";
      label.textContent = item.label;

      card.appendChild(label);
      card.addEventListener("click", () => onSelect(item));
      container.appendChild(card);
    });
  }

  function showResultSubState(state) {
    singWaiting.hidden = state !== "waiting";
    singSuccess.hidden = state !== "success";
    singError.hidden = state !== "error";
  }

  function finishSuccess(lyrics) {
    singLyrics.textContent = lyrics;
    showResultSubState("success");
    inFlight = false;
    singRetryBtn.disabled = false;
  }

  function finishFailure(kind) {
    singErrorMessage.textContent = RESULT_MESSAGES[kind] || RESULT_MESSAGES.provider_error;
    showResultSubState("error");
    inFlight = false;
    singRetryBtn.disabled = false;
  }

  // POSTs the chosen theme/style to /api/song and routes the response to the
  // success/error sub-state. Re-invoked as-is by retry and is a no-op while
  // a request is already pending — mirrors draw.js's submitTransform().
  async function submitSong() {
    if (inFlight) return;
    if (!chosenTheme || !chosenStyle) {
      console.error("QCSing: submitSong called with no chosen theme/style");
      return;
    }
    inFlight = true;
    singRetryBtn.disabled = true;
    const token = requestToken;
    showResultSubState("waiting");
    QCUI.showScreen("singResult");

    let response;
    try {
      response = await fetch("/api/song", {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-token": APP_TOKEN },
        body: JSON.stringify({ themeSeed: chosenTheme.seed, styleSeed: chosenStyle.seed }),
      });
    } catch (e) {
      if (token === requestToken) finishFailure("offline");
      return;
    }

    // The kid navigated away while this was in flight — drop the response;
    // the navigating action already reset flow state.
    if (token !== requestToken) return;

    if (response.status === 200) {
      let body = null;
      try {
        body = await response.json();
      } catch (e) {
        body = null;
      }
      if (token !== requestToken) return;
      if (body && typeof body.lyrics === "string" && body.lyrics.length > 0) {
        finishSuccess(body.lyrics);
      } else {
        finishFailure("provider_error");
      }
    } else if (response.status === 429) {
      finishFailure("cooldown");
    } else {
      finishFailure("provider_error");
    }
  }

  // --- Screen flow -------------------------------------------------------

  function enterSingTheme() {
    requestToken += 1; // abandon any in-flight/previous song flow when starting fresh
    inFlight = false;
    singRetryBtn.disabled = false;
    chosenTheme = null;
    chosenStyle = null;
    renderGrid(singThemeGrid, SING_THEMES, (item) => {
      chosenTheme = item;
      enterSingStyle();
    });
    QCUI.showScreen("singTheme");
  }

  function enterSingStyle() {
    renderGrid(singStyleGrid, SING_STYLES, (item) => {
      chosenStyle = item;
      submitSong();
    });
    QCUI.showScreen("singStyle");
  }

  function exitToStart() {
    requestToken += 1; // drop any in-flight song response
    inFlight = false;
    singRetryBtn.disabled = false;
    chosenTheme = null;
    chosenStyle = null;
    QCUI.showScreen("start");
  }

  startSingBtn.addEventListener("click", enterSingTheme);
  singThemeBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  singStyleBackBtn.addEventListener("click", () => QCUI.showScreen("singTheme"));
  singResultEndBtn.addEventListener("click", exitToStart);
  singNewBtn.addEventListener("click", enterSingTheme);
  singRetryBtn.addEventListener("click", () => {
    // submitSong() is itself a no-op while inFlight, satisfying "retry is
    // inert while a request is already pending".
    submitSong();
  });
})();
