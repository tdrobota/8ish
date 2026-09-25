// Monetization — free daily limit, Parent Gate, Parents Hub, and 8ish+ paywall.
//
// This repo now deploys one Worker (8ish-plus, free plan): a valid
// /api/config answer says planMode "free" (see wrangler.jsonc's top-level
// vars), and every gate below enforces the daily/AI limits and shows the
// Parent Gate and paywall. The retired 8ishqa Worker keeps running its own
// last-deployed copy of this file, where planMode is "unlimited" and every
// gate short-circuits to "allowed"; that Worker is not represented in this
// repo's wrangler.jsonc anymore. A failed, slow, rate-limited or invalid
// /api/config answer never means "unlimited": the app starts from the last
// good config in localStorage (8ish_config_v1), else from the free defaults,
// and only a fully valid answer replaces it. The known cost on 8ishqa: a
// first-ever visit where no valid answer arrives in 4 s runs free until one
// request succeeds; from then on its stored "unlimited" config holds, even
// offline. If this module fails to load at all, window.LIMIT is simply
// undefined — app.js and draw.js only call it defensively
// (`window.LIMIT && ...`).
(() => {
  "use strict";

  const t = window.I18N.t;

  const CONFIG_TIMEOUT_MS = 4000;
  const USAGE_KEY = "8ish_usage_v1";
  const ENTITLEMENT_KEY = "8ish_entitlement_v1";
  // Story 7.7: a free-device token minted/echoed by /api/transform's
  // free-device branch (functions/api/transform.js) -- a separate, small
  // entry from ENTITLEMENT_KEY (subscriber-only, its own distinct lifecycle/
  // clearing rules). Just the raw `d1.` token string, read by getAuth() and
  // written by setDevice() below.
  const DEVICE_KEY = "8ish_device_v1";
  // Was 24h before stripe-webhook.js existed (see entitlement.js) — now a
  // cheap KV read in the common case, so this is just a floor against
  // redundant calls on rapid reloads, not a cost-driven interval.
  const ENTITLEMENT_RECHECK_MS = 60 * 1000;

  const CONFIG_KEY = "8ish_config_v1";
  const MAX_PRICE_TEXT_LENGTH = 32;

  // --- Turnstile human check (Story 6.3, AD-16) -----------------------------
  // Read from /api/config's optional turnstileSiteKey field (see
  // functions/api/config.js) — never hardcoded here. Captured separately
  // from `config`/validateConfig() below: it isn't part of that strict,
  // localStorage-persisted shape, it's just remembered in memory for
  // getHumanToken() to use on demand. Stays null (the reality today, until
  // Story 5-1's real-device spike resolves and the widget is created) until
  // a valid /api/config answer actually carries one.
  let turnstileSiteKey = null;
  const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js";
  let turnstileScriptPromise = null;
  let turnstileWidgetId = null;
  // Set once, synchronously, when boot's IIFE below kicks off loadConfig() —
  // exposed so getHumanToken() can await this exact in-flight request
  // instead of only ever seeing whatever turnstileSiteKey happened to be
  // captured by the moment it's called.
  let configLoadPromise = null;

  // What a device runs on until a valid /api/config answer (or a stored one)
  // says otherwise. Story 6-5: pricing.monthly/yearly start `null` (never a
  // hand-set guess) -- a real value only ever comes from a config answer
  // that itself traced back to a real Stripe unit_amount (see
  // functions/api/config.js); openPaywall() below disables buying while
  // either is null rather than show a possibly-wrong number.
  function freeDefaults() {
    return {
      planMode: "free",
      freeDailyLimit: 10,
      features: { friendMode: false, familyMode: false },
      pricing: { monthly: null, yearly: null, currency: "RON" },
    };
  }

  const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";
  const isLimit = (v) => Number.isInteger(v) && v >= 1 && v <= 1000;

  // Returns a normalized copy of a config answer, or null if any field is
  // invalid. Never throws and never repairs: an answer is accepted whole or
  // ignored whole. Unknown fields are dropped; absent features/pricing take
  // the defaults. Used for /api/config answers and for the stored copy.
  function validateConfig(data) {
    try {
      if (!isPlainObject(data)) return null;
      if (data.planMode !== "free" && data.planMode !== "unlimited") return null;
      if (!isLimit(data.freeDailyLimit)) return null;

      const out = freeDefaults();
      out.planMode = data.planMode;
      out.freeDailyLimit = data.freeDailyLimit;

      if (data.features !== undefined) {
        if (!isPlainObject(data.features)) return null;
        for (const key of Object.keys(data.features)) {
          if (typeof data.features[key] !== "boolean") return null;
        }
        for (const key of Object.keys(out.features)) {
          if (typeof data.features[key] === "boolean") out.features[key] = data.features[key];
        }
      }

      if (data.pricing !== undefined) {
        if (!isPlainObject(data.pricing)) return null;
        for (const key of Object.keys(data.pricing)) {
          const v = data.pricing[key];
          // Story 6-5: monthly/yearly may be `null` (confirmed-unavailable --
          // see functions/api/config.js's own header comment); every other
          // key (currency, and any unrecognized key -- dropped below anyway)
          // must still be a non-empty, bounded string.
          const nullable = key === "monthly" || key === "yearly";
          if (nullable && v === null) continue;
          if (typeof v !== "string" || v.length < 1 || v.length > MAX_PRICE_TEXT_LENGTH) return null;
        }
        for (const key of Object.keys(out.pricing)) {
          const v = data.pricing[key];
          if (typeof v === "string") out.pricing[key] = v;
          else if ((key === "monthly" || key === "yearly") && v === null) out.pricing[key] = null;
        }
      }

      return out;
    } catch (e) {
      return null;
    }
  }

  function readStoredConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      return raw ? validateConfig(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  function storeConfig(validConfig) {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(validConfig));
    } catch (e) {
      /* storage unavailable — the answer still applies for this session */
    }
  }

  let config = readStoredConfig() || freeDefaults();

  const freeCounter = document.getElementById("freeCounter");
  const parentModeBtn = document.getElementById("parentModeBtn");
  const dailyLimitScreen = document.getElementById("dailyLimit");
  const parentGateScreen = document.getElementById("parentGate");
  const parentsHubScreen = document.getElementById("parentsHub");
  const paywallScreen = document.getElementById("paywall");
  const restoreScreen = document.getElementById("restore");
  const restoreCodeRevealScreenEl = document.getElementById("restoreCodeReveal");
  const turnstileContainer = document.getElementById("turnstileContainer");

  // Defensive: if index.html and this file ever drift apart, don't throw on
  // load and take the whole script (and window.LIMIT) down with it.
  if (
    !freeCounter ||
    !parentModeBtn ||
    !dailyLimitScreen ||
    !parentGateScreen ||
    !parentsHubScreen ||
    !paywallScreen ||
    !restoreScreen ||
    !restoreCodeRevealScreenEl ||
    !turnstileContainer
  ) {
    console.error("monetize.js: expected DOM not found, monetization disabled");
    return;
  }

  QCUI.registerScreen("dailyLimit", dailyLimitScreen);
  QCUI.registerScreen("parentGate", parentGateScreen);
  QCUI.registerScreen("parentsHub", parentsHubScreen);
  QCUI.registerScreen("paywall", paywallScreen);
  QCUI.registerScreen("restore", restoreScreen);
  QCUI.registerScreen("restoreCodeReveal", restoreCodeRevealScreenEl);

  const dailyLimitText = document.getElementById("dailyLimitText");
  const dailyLimitParentBtn = document.getElementById("dailyLimitParentBtn");
  const dailyLimitTomorrowBtn = document.getElementById("dailyLimitTomorrowBtn");
  const parentGateQuestion = document.getElementById("parentGateQuestion");
  const parentGateInput = document.getElementById("parentGateInput");
  const parentGateSubmit = document.getElementById("parentGateSubmit");
  const parentGateError = document.getElementById("parentGateError");
  const parentGateBackBtn = document.getElementById("parentGateBackBtn");
  const parentsHubBackBtn = document.getElementById("parentsHubBackBtn");
  const parentsHubSubscribed = document.getElementById("parentsHubSubscribed");
  const parentsHubNotSubscribed = document.getElementById("parentsHubNotSubscribed");
  const parentsHubRenewal = document.getElementById("parentsHubRenewal");
  const parentsHubAccessEnds = document.getElementById("parentsHubAccessEnds");
  const parentsHubCodeLabel = document.getElementById("parentsHubCodeLabel");
  const parentsHubCode = document.getElementById("parentsHubCode");
  const parentsHubCancelBtn = document.getElementById("parentsHubCancelBtn");
  const parentsHubResumeBtn = document.getElementById("parentsHubResumeBtn");
  const parentsHubActionStatus = document.getElementById("parentsHubActionStatus");
  const parentsHubUpgradeBtn = document.getElementById("parentsHubUpgradeBtn");
  const parentsHubRestoreBtn = document.getElementById("parentsHubRestoreBtn");
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

  // Used whenever local state must stop claiming entitlement: a hand-edited
  // or credential-less record on boot, or an authoritative "not active" (or
  // 401 invalid-credential) answer from the server replacing local state —
  // never just a network/offline failure, which keeps the last known
  // entitlement instead (see recheckEntitlement).
  function removeEntitlement() {
    try {
      localStorage.removeItem(ENTITLEMENT_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function isEntitled() {
    const ent = readEntitlement();
    return !!(ent && ent.active);
  }

  // --- free-device token (Story 7.7, AD-16) ---------------------------------
  // A separate, small localStorage entry from ENTITLEMENT_KEY -- see
  // DEVICE_KEY's own comment above. Just the raw `d1.` token string.

  function readDevice() {
    try {
      return localStorage.getItem(DEVICE_KEY);
    } catch (e) {
      return null;
    }
  }

  function setDevice(token) {
    try {
      localStorage.setItem(DEVICE_KEY, token);
    } catch (e) {
      /* storage unavailable — the token just won't persist for next time */
    }
  }

  // draw.js's ONLY way to read auth for /api/transform — it never reads a
  // credential or device token from localStorage directly (the story's own
  // "Always" clause). A stored subscriber credential wins over a stored
  // free-device token, and the two are never sent together. Regardless of
  // isEntitled()'s own active/inactive judgment: the server is the real
  // judge of whether a credential is still good, so a stale one is still
  // sent here and just gets a 401 back, mapped by draw.js to the same
  // generic friendly message as any other failure. Neither stored yet (the
  // very first free request on this device) returns {} — the server's own
  // free-device mint path handles that.
  function getAuth() {
    const ent = readEntitlement();
    if (ent && ent.credential) return { authorization: "Bearer " + ent.credential };
    const device = readDevice();
    if (device) return { device };
    return {};
  }

  // --- free counter --------------------------------------------------------
  // Tapping the pill (in either state) always goes through the Parent Gate
  // now — see the click listener at the bottom — so subscription validity
  // is never visible from a bare tap, only after the gate (Parents Hub).

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
    freeCounter.textContent = t("freeCounterText")
      .replace("{remaining}", remaining)
      .replace("{total}", config.freeDailyLimit);
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

  function showDailyLimit() {
    dailyLimitText.textContent = t("dailyLimitText").replace("{count}", config.freeDailyLimit);
    QCUI.showScreen("dailyLimit");
  }

  // --- Parent Gate -----------------------------------------------------------
  // A friction screen, not authentication — keeps young kids from reaching
  // parent-facing screens by accident. Always leads to the Parents Hub now
  // (see openParentsHub), which itself offers the paywall if not subscribed.

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
      openParentsHub();
    } else {
      parentGateError.hidden = false;
      generateGateQuestion();
    }
  }

  // --- Parents Hub -------------------------------------------------------
  // Everything parent-related lives here, behind the gate: subscription
  // status/renewal/restore code if entitled, or the paywall entry point if
  // not. Replaces the old direct-tap subscriptionInfo screen.

  // Shared by parentsHubRenewal and parentsHubAccessEnds — same formatting
  // both already used inline before this helper existed.
  function formatPeriodEndDate(ts) {
    return new Date(ts * 1000).toLocaleDateString(t("parent.dateLocale"), {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  function openParentsHub() {
    const entitled = isEntitled();
    parentsHubSubscribed.hidden = !entitled;
    parentsHubNotSubscribed.hidden = entitled;

    if (entitled) {
      const ent = readEntitlement();
      const ts = ent && ent.currentPeriodEnd;
      // Story 6.6: cancelAtPeriodEnd only ever comes from a completed
      // /api/subscription call this session (entitlement.js's own response
      // shape is untouched by this story) — see callSubscriptionAction and
      // readEntitlement. Cancelled: "Access ends on <date>" replaces the
      // renewal line and a Resume control appears instead of Cancel.
      const cancelled = !!(ent && ent.cancelAtPeriodEnd);
      parentsHubActionStatus.hidden = true;
      parentsHubCancelBtn.hidden = cancelled;
      parentsHubResumeBtn.hidden = !cancelled;
      resetCancelConfirm();

      if (cancelled && ts) {
        parentsHubRenewal.hidden = true;
        parentsHubAccessEnds.hidden = false;
        parentsHubAccessEnds.textContent = t("parent.accessEndsOn").replace("{date}", formatPeriodEndDate(ts));
      } else {
        parentsHubRenewal.hidden = false;
        parentsHubAccessEnds.hidden = true;
        parentsHubRenewal.textContent = ts ? t("parent.renewsOn") + formatPeriodEndDate(ts) : t("parent.renewalUnavailable");
      }

      // The restore code is only ever known on the device that originally
      // completed checkout (see confirmCheckoutFromUrl) — a device that got
      // its entitlement via restore.js never receives it back, since only
      // its hash is stored server-side. Show it here for easy re-copying if
      // the family didn't write it down the first time; otherwise say so
      // plainly rather than showing a blank field.
      const hasCode = ent && typeof ent.restoreCode === "string" && ent.restoreCode;
      parentsHubCodeLabel.hidden = !hasCode;
      parentsHubCode.hidden = !hasCode;
      if (hasCode) parentsHubCode.textContent = ent.restoreCode;
    }

    QCUI.showScreen("parentsHub");
  }

  // --- Cancel / Resume subscription (Story 6.6) -----------------------------
  // Two-tap confirm-in-place for Cancel (the risky direction): a first tap
  // relabels the SAME button to "Tap again to confirm" for a few seconds;
  // a second tap within that window calls the API. Tapping anything else, or
  // letting it time out, reverts the label with no call made (Design Notes).
  // Resume is a single tap — resuming access is not the risky direction.

  const CANCEL_CONFIRM_WINDOW_MS = 5000;
  let cancelConfirmTimer = null;
  let cancelConfirmArmed = false;

  function resetCancelConfirm() {
    if (cancelConfirmTimer) {
      clearTimeout(cancelConfirmTimer);
      cancelConfirmTimer = null;
    }
    cancelConfirmArmed = false;
    if (parentsHubCancelBtn) parentsHubCancelBtn.textContent = t("parent.cancelBtn");
  }

  // Sends the stored credential as a Bearer token (same mechanism as
  // recheckEntitlement below) and, on success, replaces the local
  // cancelAtPeriodEnd/currentPeriodEnd/active fields with the server's fresh
  // answer — never the other way around. A network/API failure leaves local
  // state untouched (same "never clear on a guess" rule recheckEntitlement
  // follows) and shows one generic status message.
  async function callSubscriptionAction(action) {
    const ent = readEntitlement();
    if (!ent || !ent.credential) return;

    parentsHubCancelBtn.disabled = true;
    parentsHubResumeBtn.disabled = true;
    parentsHubActionStatus.hidden = true;

    try {
      const res = await fetch("/api/subscription", {
        method: "POST",
        headers: { authorization: "Bearer " + ent.credential, "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error("subscription_action_failed");
      const data = await res.json();
      if (!data || typeof data.cancelAtPeriodEnd !== "boolean") throw new Error("subscription_action_bad_response");

      writeEntitlement({
        ...ent,
        active: data.active !== false,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd,
        currentPeriodEnd: data.currentPeriodEnd != null ? data.currentPeriodEnd : ent.currentPeriodEnd,
        checkedAt: Date.now(),
      });
      updateFreeCounter();
      // Re-renders Cancel/Resume visibility and the access-ends/renewal
      // line from the state just written above, and also resets .disabled
      // (see the finally block below) via the fresh openParentsHub() call.
      openParentsHub();
    } catch (e) {
      parentsHubActionStatus.hidden = false;
      parentsHubActionStatus.textContent = t("parent.subscriptionActionFailed");
    } finally {
      // Unconditional: a success path already re-renders visibility via
      // openParentsHub() above, but .disabled itself is only ever set here
      // — without this, a successful action would leave whichever button is
      // now shown permanently disabled.
      parentsHubCancelBtn.disabled = false;
      parentsHubResumeBtn.disabled = false;
    }
  }

  function handleCancelTap() {
    if (!cancelConfirmArmed) {
      cancelConfirmArmed = true;
      parentsHubCancelBtn.textContent = t("parent.cancelConfirmBtn");
      cancelConfirmTimer = setTimeout(resetCancelConfirm, CANCEL_CONFIRM_WINDOW_MS);
      return;
    }
    resetCancelConfirm();
    callSubscriptionAction("cancel");
  }

  function handleResumeTap() {
    callSubscriptionAction("resume");
  }

  // --- Paywall ---------------------------------------------------------------
  // Story 6-5: a plan's price is only ever a display-ready string once
  // config.pricing.<plan> traced back to a real Stripe unit_amount (see
  // functions/api/config.js) -- `null` means "confirmed unavailable" (a
  // Stripe/cache failure), same as a config that never loaded at all (see
  // freeDefaults()). Never guess or show a stale number: disable exactly the
  // plan(s) that are unavailable and show one generic message, matching the
  // story's own "Always" clause.

  function planPriceAvailable(plan) {
    return typeof config.pricing[plan] === "string";
  }

  // Sets each plan button's price text and disabled state from the current
  // config -- shared by openPaywall() (initial render) and startCheckout()'s
  // failure path (so a failed purchase attempt re-enables a button only if
  // its price is actually available, never blindly both). Returns whether
  // every plan's price is available.
  function applyPaywallPricing() {
    const monthlyOk = planPriceAvailable("monthly");
    const yearlyOk = planPriceAvailable("yearly");
    paywallMonthlyPrice.textContent = monthlyOk ? config.pricing.monthly + " " + config.pricing.currency + t("parent.perMonth") : "";
    paywallYearlyPrice.textContent = yearlyOk ? config.pricing.yearly + " " + config.pricing.currency + t("parent.perYear") : "";
    paywallMonthlyBtn.disabled = !monthlyOk;
    paywallYearlyBtn.disabled = !yearlyOk;
    return monthlyOk && yearlyOk;
  }

  // Story 8-2: a fire-and-forget, best-effort funnel signal -- never
  // awaited, never surfacing a failure to the parent, never blocking or
  // gating the screen transition it accompanies. keepalive lets the
  // request survive this function returning immediately after. A rejected
  // fetch is swallowed silently -- this counter is read once a day by the
  // owner, not a signal the parent's experience can ever depend on.
  function reportEvent(eventName) {
    fetch("/api/e", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: eventName }),
      keepalive: true,
    }).catch(() => {});
  }

  function openPaywall() {
    reportEvent("paywall_viewed");
    const allAvailable = applyPaywallPricing();
    paywallStatus.hidden = allAvailable;
    if (!allAvailable) paywallStatus.textContent = t("parent.pricingUnavailable");
    QCUI.showScreen("paywall");
  }

  // Story 6.4: a Turnstile token (action "checkout", same getHumanToken()
  // Restore already uses) is required before /api/checkout is ever called,
  // and the active language travels with the request so the Waiver text
  // Stripe shows matches what this device is displaying. One generic
  // failure message either way — a failed/skipped human check, a network
  // problem, or Stripe itself failing all look identical here, matching the
  // restore screen's own pattern (Story 6.3): distinguishing any of them
  // would leak information a caller could probe with.
  async function startCheckout(plan) {
    paywallStatus.hidden = false;
    paywallStatus.textContent = t("parent.loading");
    paywallMonthlyBtn.disabled = true;
    paywallYearlyBtn.disabled = true;
    try {
      const turnstileToken = await getHumanToken("checkout");
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan, turnstile: turnstileToken, lang: window.I18N.lang }),
      });
      if (!res.ok) throw new Error("checkout_failed");
      const data = await res.json();
      if (!data.url) throw new Error("checkout_no_url");
      window.location.href = data.url;
    } catch (e) {
      // Re-derive each button's disabled state from the current config
      // rather than blindly re-enabling both -- a plan whose price is
      // confirmed unavailable must stay disabled even after a failed
      // attempt (see applyPaywallPricing()).
      applyPaywallPricing();
      paywallStatus.hidden = false;
      paywallStatus.textContent = t("parent.checkoutFailed");
    }
  }

  // --- Turnstile human check (Story 6.3, AD-16) -----------------------------
  // window.LIMIT.getHumanToken(action) is the ONE place in this app that
  // creates a Turnstile widget — restore.js (below) is its only caller
  // today; Story 7.6's free-Image gate is expected to reuse it later. Loads
  // Cloudflare's script on first use, renders exactly one widget into
  // #turnstileContainer (hidden until it actually renders — see
  // index.html), and resolves with the token on completion or rejects.
  //
  // Fails closed with no site key: rejects with "turnstile_not_configured"
  // rather than fabricating a token or silently skipping the check — the
  // server still requires a real, verified token (lib/turnstile.js), so an
  // unconfigured Turnstile means the calling feature is UNAVAILABLE, never
  // insecure. This is the case today: turnstileSiteKey is null until
  // Story 5-1's real-device spike resolves and a widget is created.
  //
  // Widget mode (managed vs. invisible) is a working default, not a final
  // decision — Story 5-1 settles that for real (see the story's own "Ask
  // First"); this uses Turnstile's standard managed widget.
  //
  // On a load failure (script.onerror, or an onload that somehow still
  // leaves window.turnstile undefined) the memoized promise is reset to
  // null so a LATER getHumanToken() call retries the script load instead of
  // reusing the same rejected promise forever — otherwise one network
  // hiccup would permanently disable Restore for the rest of the session.
  function loadTurnstileScript() {
    if (turnstileScriptPromise) return turnstileScriptPromise;
    turnstileScriptPromise = new Promise((resolve, reject) => {
      if (window.turnstile) {
        resolve(window.turnstile);
        return;
      }
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.turnstile) {
          resolve(window.turnstile);
        } else {
          turnstileScriptPromise = null;
          reject(new Error("turnstile_load_failed"));
        }
      };
      script.onerror = () => {
        turnstileScriptPromise = null;
        reject(new Error("turnstile_load_failed"));
      };
      document.head.appendChild(script);
    });
    return turnstileScriptPromise;
  }

  // Settles whichever getHumanToken() call is currently waiting on a
  // rendered widget's user interaction, if any — see getHumanToken() below.
  let pendingTurnstileReject = null;

  async function getHumanToken(action) {
    // A legitimately fast first restore attempt can call this before
    // loadConfig()'s in-flight /api/config request has settled — wait for
    // it so this doesn't report "not configured" a moment before a real
    // site key would have arrived. loadConfig() catches its own failures
    // internally and never actually rejects; the try/catch here is only
    // defensive against that ever changing.
    if (configLoadPromise) {
      try {
        await configLoadPromise;
      } catch (e) {
        /* ignore — see above */
      }
    }

    if (!turnstileSiteKey) throw new Error("turnstile_not_configured");

    // A second call arriving while an earlier call's widget is still
    // awaiting user interaction must not leave that earlier call's promise
    // hanging forever — settle it (as a supersession, not a silent
    // success) before tearing down its widget below.
    if (pendingTurnstileReject) {
      const reject = pendingTurnstileReject;
      pendingTurnstileReject = null;
      reject(new Error("turnstile_superseded"));
    }

    const turnstileApi = await loadTurnstileScript();

    return new Promise((resolve, reject) => {
      pendingTurnstileReject = reject;
      const settle = (fn, value) => {
        if (pendingTurnstileReject === reject) pendingTurnstileReject = null;
        fn(value);
      };
      try {
        if (turnstileWidgetId !== null) {
          turnstileApi.remove(turnstileWidgetId);
          turnstileWidgetId = null;
        }
        turnstileContainer.hidden = false;
        turnstileWidgetId = turnstileApi.render(turnstileContainer, {
          sitekey: turnstileSiteKey,
          action,
          callback: (token) => settle(resolve, token),
          "error-callback": () => settle(reject, new Error("turnstile_failed")),
          "expired-callback": () => settle(reject, new Error("turnstile_expired")),
          "timeout-callback": () => settle(reject, new Error("turnstile_failed")),
        });
      } catch (e) {
        settle(reject, new Error("turnstile_failed"));
      }
    });
  }

  // Clears any widget left over from a previous, uncompleted attempt (the
  // user backed out mid-check and reopened Restore) so a stale widget isn't
  // still showing — mirrors the same removal getHumanToken() itself does
  // before rendering a fresh one, just triggered by (re)opening the screen
  // instead of by a new human-check call.
  function resetTurnstileWidget() {
    turnstileContainer.hidden = true;
    if (turnstileWidgetId !== null && window.turnstile) {
      try {
        window.turnstile.remove(turnstileWidgetId);
      } catch (e) {
        /* best effort — a widget the API can no longer find isn't worth throwing over */
      }
    }
    turnstileWidgetId = null;
  }

  // --- restore purchase by email + saved code -------------------------------
  // No accounts in this app, so entitlement lives in localStorage on one
  // device. This recovers it elsewhere (second device, cleared storage,
  // private browsing) using the email Stripe Checkout already collected PLUS
  // the one-time restore code shown once at purchase (see
  // confirmCheckoutFromUrl below and functions/api/checkout-confirm.js) —
  // requiring both, rather than trusting a submitted email alone, is what
  // fixes an authorization bypass an earlier email-only version of this had.
  // Story 6.3: a Turnstile token (getHumanToken above) is required too, and
  // a successful restore now stores a real credential, the same shape a
  // fresh purchase does (see confirmCheckoutFromUrl).

  function openRestore() {
    restoreError.hidden = true;
    restoreStatus.hidden = true;
    restoreEmailInput.value = "";
    restoreCodeInput.value = "";
    restoreSubmitBtn.disabled = false;
    resetTurnstileWidget();
    QCUI.showScreen("restore");
    restoreEmailInput.focus();
  }

  // One generic failure message for ANY restore failure — a wrong email, a
  // wrong code, no active subscription, a failed/skipped human check, or a
  // network problem all look identical here. Distinguishing any of them
  // (especially the human check) would leak information a caller could
  // probe with; see the story's own "Always" clause.
  async function submitRestore() {
    const email = restoreEmailInput.value.trim();
    const code = restoreCodeInput.value.trim();
    if (!email || !code) return;
    restoreError.hidden = true;
    restoreStatus.hidden = false;
    restoreStatus.textContent = t("parent.loading");
    restoreSubmitBtn.disabled = true;
    try {
      const turnstileToken = await getHumanToken("restore");
      const res = await fetch("/api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code, turnstile: turnstileToken }),
      });
      if (!res.ok) throw new Error("restore_failed");
      const data = await res.json();
      if (data && data.active && data.credential) {
        writeEntitlement({
          active: true,
          credential: data.credential,
          plan: data.plan,
          currentPeriodEnd: data.currentPeriodEnd,
          // Not returned by restore.js (only the code's hash is stored
          // server-side, never recoverable) — a device that got entitlement
          // this way just won't have a code to show later in Parents Hub.
          restoreCode: null,
          // Not returned by restore.js either — restore.js's own contract
          // is untouched by this story (see subscription.js's header
          // comment). A device restoring here has no way to know a
          // cancellation was already scheduled elsewhere until the next
          // successful /api/subscription call on THIS device sets it.
          cancelAtPeriodEnd: false,
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

  // The 4 s timeout covers the whole request, body included. Any failure —
  // offline, timeout, non-2xx (429/5xx too), bad JSON, an answer that does not
  // validate — leaves `config` as it was (stored config, else free defaults)
  // and stores nothing.
  async function loadConfig() {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("config_timeout"));
      }, CONFIG_TIMEOUT_MS);
    });
    const request = (async () => {
      const res = await fetch("/api/config", { signal: controller.signal });
      if (!res.ok) return null;
      return res.json();
    })();
    request.catch(() => {}); // a late failure after the timeout is not an error
    try {
      const raw = await Promise.race([request, timedOut]);
      const valid = validateConfig(raw);
      if (valid) {
        config = valid;
        storeConfig(valid);
      }
      // Captured independent of validateConfig()'s strict shape — see the
      // Turnstile section above. Never persisted to localStorage: a stale
      // site key surviving a later reconfiguration is not a risk worth
      // trading against getHumanToken() always reading a fresh-enough value.
      if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.turnstileSiteKey === "string" && raw.turnstileSiteKey) {
        turnstileSiteKey = raw.turnstileSiteKey;
      }
    } catch (e) {
      /* offline, timed out or unreadable — keep the current config */
    } finally {
      clearTimeout(timer);
    }
  }

  async function confirmCheckoutFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session_id");
    if (params.get("checkout") !== "success" || !sessionId) return;

    // Strip the query string immediately so a page refresh can't re-trigger
    // this, and so the session id never lingers in the URL bar or browser
    // history — it is sent only in the POST body below, never a query string.
    window.history.replaceState({}, "", window.location.pathname);

    try {
      const res = await fetch("/api/checkout/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.active && data.credential) {
        writeEntitlement({
          active: true,
          credential: data.credential,
          plan: data.plan,
          currentPeriodEnd: data.currentPeriodEnd,
          restoreCode: data.restoreCode || null,
          // checkout-confirm.js's own contract is untouched by this story
          // (see subscription.js's header comment) — a fresh purchase is
          // never already cancelled.
          cancelAtPeriodEnd: false,
          checkedAt: Date.now(),
        });
      }
      // restoreCode is only ever present on the very first confirmation for
      // a given Stripe customer (see checkout-confirm.js), and — unlike the
      // credential — the server still issues it for a genuinely paid and
      // active session even if the session itself is too old to mint a
      // credential from (a slow checkout, not a replay): without seeing it
      // here the family would have no self-serve way back in at all, so the
      // reveal does not require data.credential the way writeEntitlement
      // above does. A repeat call (e.g. a stray page reload before the query
      // string strip above lands) gets no code either way, so this only
      // fires once, right when the family needs to see and save it.
      if (data && data.active && data.restoreCode) openRestoreCodeReveal(data.restoreCode);
    } catch (e) {
      /* the subscription still exists on Stripe's side even if this
         confirm call itself dropped — a device that never received a
         credential here has no periodic recheck to fall back on (see
         recheckEntitlement) until the family uses Restore */
    }
  }

  // Sends the stored credential and replaces local subscription state with
  // whatever the server answers — never the other way around. Outcomes:
  // (1) no stored record, or one with no credential at all (hand-edited, or
  // a pre-6.3 restore.js record — see submitRestore) — cleared without a
  // network call, since there is nothing valid to send; (2) an explicit,
  // authoritative live answer — {active:true, credential} updates the
  // record with the fresh credential; {active:false} clears it; a live 401
  // (an invalid/expired credential, server-side) also clears it; (3)
  // anything else — offline/network failure, a non-2xx that isn't 401, or a
  // 200 answer that doesn't parse to one of the two explicit shapes above
  // (e.g. active:true with no credential — malformed, not a real "no") — is
  // treated as a hiccup and leaves the last known entitlement untouched,
  // never clears it on a guess.
  //
  // Re-entrancy guard: this is only ever called once today (at boot), but a
  // future caller (e.g. a manual refresh from the Parents Hub) invoking it
  // again while an earlier call's fetch is still in flight must not let two
  // overlapping responses race and let an older one's write/clear overwrite
  // a newer one's.
  let recheckInFlight = false;

  async function recheckEntitlement() {
    if (recheckInFlight) return;
    recheckInFlight = true;
    try {
      const ent = readEntitlement();
      if (!ent) return;

      if (!ent.credential) {
        if (ent.active) removeEntitlement();
        return;
      }

      if (ent.checkedAt && Date.now() - ent.checkedAt < ENTITLEMENT_RECHECK_MS) return;

      try {
        const res = await fetch("/api/entitlement", {
          method: "POST",
          headers: { authorization: "Bearer " + ent.credential, "content-type": "application/json" },
        });
        if (!res.ok) {
          if (res.status === 401) removeEntitlement();
          return;
        }
        const data = await res.json();
        if (data && data.active === true && data.credential) {
          writeEntitlement({
            ...ent,
            active: true,
            credential: data.credential,
            currentPeriodEnd: data.currentPeriodEnd != null ? data.currentPeriodEnd : ent.currentPeriodEnd,
            checkedAt: Date.now(),
          });
        } else if (data && data.active === false) {
          removeEntitlement();
        }
        // Any other shape (most notably active:true with a missing/falsy
        // credential — a malformed or unexpected answer) is deliberately
        // NOT treated as "clear it": only an explicit active:false or a 401
        // is authoritative enough to drop a subscriber's access.
      } catch (e) {
        /* offline — keep the last known entitlement until we can reach the server */
      }
    } finally {
      recheckInFlight = false;
    }
  }

  dailyLimitParentBtn.addEventListener("click", openParentGate);
  dailyLimitTomorrowBtn.addEventListener("click", () => QCUI.showScreen("start"));
  parentGateBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  parentGateSubmit.addEventListener("click", checkParentGate);
  parentGateInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") checkParentGate();
  });
  parentsHubBackBtn.addEventListener("click", () => {
    resetCancelConfirm();
    QCUI.showScreen("start");
  });
  parentsHubUpgradeBtn.addEventListener("click", openPaywall);
  parentsHubRestoreBtn.addEventListener("click", openRestore);
  parentsHubCancelBtn.addEventListener("click", handleCancelTap);
  parentsHubResumeBtn.addEventListener("click", handleResumeTap);
  paywallBackBtn.addEventListener("click", () => QCUI.showScreen("start"));
  paywallMonthlyBtn.addEventListener("click", () => startCheckout("monthly"));
  paywallYearlyBtn.addEventListener("click", () => startCheckout("yearly"));
  paywallRestoreBtn.addEventListener("click", openRestore);
  restoreBackBtn.addEventListener("click", () => QCUI.showScreen("parentsHub"));
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
    openParentGate();
  });
  parentModeBtn.addEventListener("click", openParentGate);

  window.LIMIT = { tryConsume, showDailyLimit, getHumanToken, getAuth, setDevice };

  (async () => {
    // Assigned synchronously (before the first await below runs) so it's
    // already set for any getHumanToken() call that could possibly happen
    // after this script finishes executing — see its own declaration above.
    configLoadPromise = loadConfig();
    await configLoadPromise;
    // Show the counter and the Parent Gate button as soon as the config is
    // settled: the confirm and recheck calls below have no timeout, and a
    // hanging one must not keep enforced limits invisible.
    updateFreeCounter();
    await confirmCheckoutFromUrl();
    await recheckEntitlement();
    updateFreeCounter();
  })();
})();
