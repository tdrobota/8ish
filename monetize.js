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
  // Was 24h before stripe-webhook.js existed (see entitlement.js) — now a
  // cheap KV read in the common case, so this is just a floor against
  // redundant calls on rapid reloads, not a cost-driven interval.
  const ENTITLEMENT_RECHECK_MS = 60 * 1000;

  let config = {
    planMode: "unlimited",
    freeDailyLimit: 10,
    freeAiLimit: 1,
    features: { friendMode: false, familyMode: false },
    pricing: { monthly: "19.99", yearly: "149", currency: "RON" },
  };

  const freeCounter = document.getElementById("freeCounter");
  const parentModeBtn = document.getElementById("parentModeBtn");
  const dailyLimitScreen = document.getElementById("dailyLimit");
  const parentGateScreen = document.getElementById("parentGate");
  const paywallScreen = document.getElementById("paywall");
  const restoreScreen = document.getElementById("restore");
  const subscriptionInfoScreen = document.getElementById("subscriptionInfo");
  const restoreCodeRevealScreenEl = document.getElementById("restoreCodeReveal");

  // Defensive: if index.html and this file ever drift apart, don't throw on
  // load and take the whole script (and window.LIMIT) down with it.
  if (
    !freeCounter ||
    !parentModeBtn ||
    !dailyLimitScreen ||
    !parentGateScreen ||
    !paywallScreen ||
    !restoreScreen ||
    !subscriptionInfoScreen ||
    !restoreCodeRevealScreenEl
  ) {
    console.error("monetize.js: expected DOM not found, monetization disabled");
    return;
  }

  QCUI.registerScreen("dailyLimit", dailyLimitScreen);
  QCUI.registerScreen("parentGate", parentGateScreen);
  QCUI.registerScreen("paywall", paywallScreen);
  QCUI.registerScreen("restore", restoreScreen);
  QCUI.registerScreen("subscriptionInfo", subscriptionInfoScreen);
  QCUI.registerScreen("restoreCodeReveal", restoreCodeRevealScreenEl);

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
  const paywallRestoreBtn = document.getElementById("paywallRestoreBtn");
  const restoreBackBtn = document.getElementById("restoreBackBtn");
  const restoreEmailInput = document.getElementById("restoreEmailInput");
  const restoreCodeInput = document.getElementById("restoreCodeInput");
  const restoreSubmitBtn = document.getElementById("restoreSubmitBtn");
  const restoreError = document.getElementById("restoreError");
  const restoreStatus = document.getElementById("restoreStatus");
  const subscriptionInfoBackBtn = document.getElementById("subscriptionInfoBackBtn");
  const subscriptionInfoRenewal = document.getElementById("subscriptionInfoRenewal");
  const subscriptionInfoCodeLabel = document.getElementById("subscriptionInfoCodeLabel");
  const subscriptionInfoCode = document.getElementById("subscriptionInfoCode");
  const restoreCodeRevealValue = document.getElementById("restoreCodeRevealValue");
  const restoreCodeRevealContinueBtn = document.getElementById("restoreCodeRevealContinueBtn");

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
    parentModeBtn.hidden = config.planMode === "unlimited";
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

  // --- subscription status (renewal date) -----------------------------------

  function openSubscriptionInfo() {
    const ent = readEntitlement();
    const ts = ent && ent.currentPeriodEnd;
    subscriptionInfoRenewal.textContent = ts
      ? "Se reînnoiește pe " + new Date(ts * 1000).toLocaleDateString("ro-RO", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "Data reînnoirii nu este disponibilă momentan.";
    // The restore code is only ever known on the device that originally
    // completed checkout (see confirmCheckoutFromUrl) — a device that got
    // its entitlement via restore.js never receives it back, since only its
    // hash is stored server-side. Show it here for easy re-copying if the
    // family didn't write it down the first time; otherwise say so plainly
    // rather than showing a blank field.
    const hasCode = ent && typeof ent.restoreCode === "string" && ent.restoreCode;
    subscriptionInfoCodeLabel.hidden = !hasCode;
    subscriptionInfoCode.hidden = !hasCode;
    if (hasCode) subscriptionInfoCode.textContent = ent.restoreCode;
    QCUI.showScreen("subscriptionInfo");
  }

  // --- restore purchase by email + saved code -------------------------------
  // No accounts in this app, so entitlement lives in localStorage on one
  // device. This recovers it elsewhere (second device, cleared storage,
  // private browsing) using the email Stripe Checkout already collected PLUS
  // the one-time restore code shown once at purchase (see
  // confirmCheckoutFromUrl below and functions/api/checkout-confirm.js) —
  // requiring both, rather than trusting a submitted email alone, is what
  // fixes an authorization bypass an earlier email-only version of this had.

  function openRestore() {
    restoreError.hidden = true;
    restoreStatus.hidden = true;
    restoreEmailInput.value = "";
    restoreCodeInput.value = "";
    restoreSubmitBtn.disabled = false;
    QCUI.showScreen("restore");
    restoreEmailInput.focus();
  }

  // A wrong email, wrong code, or no active subscription all get the same
  // generic message — never distinguishable, so this can't be used to probe
  // for valid emails.
  async function submitRestore() {
    const email = restoreEmailInput.value.trim();
    const code = restoreCodeInput.value.trim();
    if (!email || !code) return;
    restoreError.hidden = true;
    restoreStatus.hidden = false;
    restoreStatus.textContent = "Un moment...";
    restoreSubmitBtn.disabled = true;
    try {
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) throw new Error("restore_failed");
      const data = await res.json();
      if (data && data.active) {
        writeEntitlement({
          active: true,
          subscriptionId: data.subscriptionId,
          plan: data.plan,
          currentPeriodEnd: data.currentPeriodEnd,
          // Not returned by restore.js (only the code's hash is stored
          // server-side, never recoverable) — a device that got entitlement
          // this way just won't have a code to show later on
          // subscriptionInfo; see the hasCode check there.
          restoreCode: null,
          checkedAt: Date.now(),
        });
        updateFreeCounter();
        restoreStatus.hidden = true;
        QCUI.showScreen("start");
      } else {
        restoreStatus.hidden = true;
        restoreError.hidden = false;
        restoreSubmitBtn.disabled = false;
      }
    } catch (e) {
      restoreStatus.hidden = true;
      restoreError.hidden = false;
      restoreSubmitBtn.disabled = false;
    }
  }

  // --- restore code reveal (shown once, right after a fresh purchase) ------

  function openRestoreCodeReveal(code) {
    restoreCodeRevealValue.textContent = code;
    QCUI.showScreen("restoreCodeReveal");
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
          currentPeriodEnd: data.currentPeriodEnd,
          restoreCode: data.restoreCode || null,
          checkedAt: Date.now(),
        });
        // restoreCode is only ever present on the very first confirmation
        // for a given Stripe customer (see checkout-confirm.js) — a repeat
        // call (e.g. a stray page reload before the query string strip
        // above lands) gets active:true again but no code, so this only
        // fires once, right when the family needs to see and save it.
        if (data.restoreCode) openRestoreCodeReveal(data.restoreCode);
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
      writeEntitlement({
        ...ent,
        active: !!data.active,
        currentPeriodEnd: data.currentPeriodEnd != null ? data.currentPeriodEnd : ent.currentPeriodEnd,
        checkedAt: Date.now(),
      });
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
  paywallRestoreBtn.addEventListener("click", openRestore);
  restoreBackBtn.addEventListener("click", () => QCUI.showScreen("paywall"));
  restoreSubmitBtn.addEventListener("click", submitRestore);
  restoreEmailInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitRestore();
  });
  restoreCodeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitRestore();
  });
  restoreCodeRevealContinueBtn.addEventListener("click", () => QCUI.showScreen("start"));
  freeCounter.addEventListener("click", () => {
    if (config.planMode === "unlimited") return;
    if (isEntitled()) openSubscriptionInfo();
    else openParentGate();
  });
  parentModeBtn.addEventListener("click", openParentGate);
  subscriptionInfoBackBtn.addEventListener("click", () => QCUI.showScreen("start"));

  window.LIMIT = { tryConsume, tryConsumeAi, showDailyLimit };

  (async () => {
    await loadConfig();
    await confirmCheckoutFromUrl();
    await recheckEntitlement();
    updateFreeCounter();
  })();
})();
