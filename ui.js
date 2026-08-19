(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

  // --- Screens registry -----------------------------------------------

  const screens = {};

  function registerScreen(name, element) {
    screens[name] = element;
  }

  function showScreen(name) {
    Object.keys(screens).forEach((key) => {
      screens[key].hidden = key !== name;
    });
  }

  // --- Icon helper -------------------------------------------------------

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

  // --- Countdown ring ------------------------------------------------

  // elements: { ringButton, ringFg, number } — the tappable ring button, its
  // animated foreground circle, and the label/number span inside it.
  function createCountdownRing(elements, { onComplete } = {}) {
    const { ringButton, ringFg, number } = elements;
    let interval = null;
    let pendingSeconds = 0;

    function reset() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      ringFg.style.transition = "none";
      ringFg.style.strokeDashoffset = "0";
      ringButton.classList.remove("timer-idle");
      number.classList.remove("timer-label", "timer-done");
      pendingSeconds = 0;
    }

    // Shows the ring full, labeled "START" — the kid taps it to begin the countdown.
    function setIdle(seconds) {
      reset();
      pendingSeconds = seconds;
      ringButton.classList.add("timer-idle");
      number.classList.add("timer-label");
      number.textContent = "START";
    }

    function start() {
      if (!pendingSeconds || interval) return;
      const seconds = pendingSeconds;
      pendingSeconds = 0;

      ringButton.classList.remove("timer-idle");
      number.classList.remove("timer-label");
      number.textContent = String(seconds);
      ringFg.style.transition = "none";
      ringFg.style.strokeDashoffset = "0";
      // Force reflow so the transition below actually animates from 0.
      void ringFg.getBoundingClientRect();
      ringFg.style.transition = `stroke-dashoffset ${seconds}s linear`;
      ringFg.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

      let remaining = seconds;
      interval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(interval);
          interval = null;
          number.textContent = "GATA!";
          number.classList.add("timer-label", "timer-done");
          if (typeof onComplete === "function") onComplete();
        } else {
          number.textContent = String(remaining);
        }
      }, 1000);
    }

    return { reset, setIdle, start };
  }

  window.QCUI = {
    registerScreen,
    showScreen,
    iconEl,
    createCountdownRing,
  };
})();
