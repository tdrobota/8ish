// Monetization — free daily limit, Parent Gate, and 8ish+ paywall.
//
// Everything here is a no-op on the kid's own deploy: /api/config returns
// planMode "unlimited" there (see wrangler.jsonc's top-level vars vs.
// env.plus), and every gate below short-circuits to "allowed" in that mode.
// If this module fails to load at all, or the /api/config fetch fails,
// window.LIMIT is simply undefined/never overrides its default — app.js and
// draw.js only call it defensively (`window.LIMIT && ...`), so the kid's
// link keeps working exactly as before regardless of what happens here.
(() => {
  "use strict";

  const CONFIG_TIMEOUT_MS = 4000;
  const USAGE_KEY = "8ish_usage_v1";
  const AI_USAGE_KEY = "8ish_ai_usage_v1";
  const ENTITLEMENT_KEY = "8ish_entitlement_v1";
  const ENTITLEMENT_RECHECK_MS = 24 * 60 * 60 * 1000;

  let config = {
    planMode: "unlimited",
    freeDailyLimit: 10,
    freeAiLimit: 1,
    features: { friendMode: false, familyMode: false },
    pricing: { monthly: "19.99", yearly: "149", currency: "RON" },
  };

  const freeCounter = document.getElementById("freeCounter");
  const dailyLimitScreen = document.getElementById("dailyLimit");
  const parentGateScreen = document.getElementById("parentGate");
  const paywallScreen = document.getElementById("paywall");

  // Defensive: if index.html and this file ever drift apart, don't throw on
  // load and take the whole script (and window.LIMIT) down with it.
  if (!freeCounter || !dailyLimitScreen || !parentGateScreen || !paywallScreen) {
    console.error("monetize.js: expected DOM not found, monetization disabled");
    return;
  }

  QCUI.registerScreen("dailyLimit", dailyLimitScreen);
  QCUI.registerScreen("parentGate", parentGateScreen);
  QCUI.registerScreen("paywall", paywallScreen);

  const dailyLimitCount = document.getElementById("dailyLimitCount");
  const dailyLimitParentBtn = document.getElementById("dailyLimitParentBtn");
  const dailyLimitTomorrowBtn = document.getElementById("dailyLimitTomorrowBtn");
  const parentGateQuestion = document.getElementById("parentGateQuestion");
  const parentGateInput = document.getElementById("parentGateInput");
  const parentGateSubmit = document.getElementById("parentGateSubmit");
  const parentGateError = document.getElementById("parentGateError");
  const parentGateBackBtn = document.getElementById("parentGateBackBtn");
  const paywallBackBtn = document.getElementById("paywallBackBtn");
  const paywallMonthlyBtn = document.getElementById("paywallMonthlyBtn");
  const paywallYearlyBtn = document.getElementById("paywallYearlyBtn");
  const paywallMonthlyPrice = document.getElementById("paywallMonthlyPrice");
  const paywallYearlyPrice = document.getElementById("paywallYearlyPrice");
  const paywallStatus = document.getElementById("paywallStatus");

  // --- local usage/entitlement storage ------------------------------------
  // Client-side only, same trust model as everything else in this app right
  // now: good enough to make "10 free/day" real for an honest family, not
  // meant to resist a technical user editing localStorage. Hardening this
  // server-side is a deliberate later step, not an oversight.

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }

  function readUsage(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return { date: todayKey(), count: 0 };
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.date !== todayKey()) return { date: todayKey(), count: 0 };
      return parsed;
    } catch (e) {
      return { date: todayKey(), count: 0 };
    }
  }

  function writeUsage(key, usage) {
    try {
      localStorage.setItem(key, JSON.stringify(usage));
    } catch (e) {
      /* storage unavailable (private mode, quota) — degrades to unlimited
         for this session rather than blocking the app */
    }
  }

  function readEntitlement() {
    try {
      const raw = localStorage.getItem(ENTITLEMENT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeEntitlement(data) {
    try {
      localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify(data));
    } catch (e) {
      /* ignore */
    }
  }

  function isEntitled() {
    const ent = readEntitlement();
    return !!(ent && ent.active);
  }

  // --- free counter --------------------------------------------------------

  function updateFreeCounter() {
    if (config.planMode === "unlimited") {
      freeCounter.hidden = true;
      return;
    }
    if (isEntitled()) {
      freeCounter.hidden = false;
      freeCounter.textContent = "8ish+ ∞";
      return;
    }
    const usage = readUsage(USAGE_KEY);
    const remaining = Math.max(0, config.freeDailyLimit - usage.count);
    freeCounter.hidden = false;
    freeCounter.textContent = remaining + " din " + config.freeDailyLimit + " activități rămase azi";
  }

  // --- gates called from app.js / draw.js ----------------------------------

  function tryConsume() {
    if (config.planMode === "unlimited" || isEntitled()) return true;
    const usage = readUsage(USAGE_KEY);
    if (usage.count >= config.freeDailyLimit) return false;
    usage.count += 1;
    writeUsage(USAGE_KEY, usage);
    updateFreeCounter();
    return true;
  }

  function tryConsumeAi() {
    if (config.planMode === "unlimited" || isEntitled()) return true;
    const usage = readUsage(AI_USAGE_KEY);
    if (usage.count >= config.freeAiLimit) return false;
    usage.count += 1;
    writeUsage(AI_USAGE_KEY, usage);
    return true;
  }

  function showDailyLimit() {
    dailyLimitCount.textContent = String(config.freeDailyLimit);
    QCUI.showScreen("dailyLimit");
  }

  // --- Parent Gate -----------------------------------------------------------

  function generateGateQuestion() {
    const a = 2 + Math.floor(Math.random() * 8);
    const b = 2 + Math.floor(Math.random() * 8);
    parentGateScreen.dataset.answer = String(a * b);
    parentGateQuestion.textContent = a + " × " + b + " = ?";
    parentGateInput.value = "";
  }

  function openParentGate() {
    generateGateQuestion();
    parentGateError.hidden = true;
    QCUI.showScreen("parentGate");
    parentGateInput.focus();
  }

  function checkParentGate() {
    if (parentGateInput.value.trim() === parentGateScreen.dataset.answer) {
      openPaywall();
    } else {
      parentGateError.hidden = false;
      generateGateQuestion();
    }
  }

  // --- Paywall ---------------------------------------------------------------

  function openPaywall() {
    paywallMonthlyPrice.textContent = config.pricing.monthly + " " + config.pricing.currency + "/lună";
    paywallYearlyPrice.textContent = config.pricing.yearly + " " + config.pricing.currency + "/an";
    paywallStatus.hidden = true;
    paywallMonthlyBtn.disabled = false;
    paywallYearlyBtn.disabled = false;
    QCUI.showScreen("paywall");
  }

  async function startCheckout(plan) {
    paywallStatus.hidden = false;
    paywallStatus.textContent = "Un moment...";
    paywallMonthlyBtn.disabled = true;
    paywallYearlyBtn.disabled = true;
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (!res.ok) throw new Error("checkout_failed");
      const data = await res.json();
      if (!data.url) throw new Error("checkout_no_url");
      window.location.href = data.url;
    } catch (e) {
      paywallStatus.textContent = "Nu am putut porni plata. Încearcă din nou.";
      paywallMonthlyBtn.disabled = false;
      paywallYearlyBtn.disabled = false;
    }
  }

  // --- boot: config, return-from-checkout confirm, entitlement recheck -----

  async function loadConfig() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    try {
      const res = await fetch("/api/config", { signal: controller.signal });
      if (res.ok) {
        const data = await res.json();
        config = {
          ...config,
          ...data,
          features: { ...config.features, ...data.features },
          pricing: { ...config.pricing, ...data.pricing },
        };
      }
    } catch (e) {
      /* offline, or the endpoint isn't reachable — config stays at its
         "unlimited" default above, which is the safe direction to fail in */
    } finally {
      clearTimeout(timer);
    }
  }

  async function confirmCheckoutFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("checkout") !== "success" || !sessionId) return;

    // Strip the query string immediately so a page refresh can't re-trigger this.
    window.history.replaceState({}, "", window.location.pathname);

    try {
      const res = await fetch("/api/checkout/confirm?session_id=" + encodeURIComponent(sessionId));
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.active) {
        writeEntitlement({
          active: true,
          subscriptionId: data.subscriptionId,
          plan: data.plan,
          checkedAt: Date.now(),
        });
      }
    } catch (e) {
      /* the subscription still exists on Stripe's side even if this
         confirm call itself dropped — the periodic recheck below will
         pick it up on a later visit */
    }
  }

  async function recheckEntitlement() {
    const ent = readEntitlement();
    if (!ent || !ent.subscriptionId) return;
    if (ent.checkedAt && Date.now() - ent.checkedAt < ENTITLEMENT_RECHECK_MS) return;
    try {
      const res = await fetch("/api/entitlement?subscription_id=" + encodeURIComponent(ent.subscriptionId));
      if (!res.ok) return;
      const data = await res.json();
      writeEntitlement({ ...ent, active: !!data.active, checkedAt: Date.now() });
    } catch (e) {
      /* offline — keep the last known entitlement until we can reach the server */
    }
  }

  dailyLimitParentBtn.addEventListener("click", openParentGate);
  dailyLimitTomorrowBtn.addEventListener("click", () => QCUI.showScreen("start"));
  parentGateBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  parentGateSubmit.addEventListener("click", checkParentGate);
  parentGateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkParentGate();
  });
  paywallBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  paywallMonthlyBtn.addEventListener("click", () => startCheckout("monthly"));
  paywallYearlyBtn.addEventListener("click", () => startCheckout("yearly"));
  freeCounter.addEventListener("click", () => {
    if (config.planMode !== "unlimited" && !isEntitled()) openParentGate();
  });

  window.LIMIT = { tryConsume, tryConsumeAi, showDailyLimit };

  (async () => {
    await loadConfig();
    await confirmCheckoutFromUrl();
    await recheckEntitlement();
    updateFreeCounter();
  })();
})();
