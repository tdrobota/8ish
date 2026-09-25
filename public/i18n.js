// i18n — language state, UI string dictionary, and content-bank selection.
// Loaded after every content file (questions.js, challenges.js, games.js,
// prompts.js, templates.js) but before ui.js/app.js/draw.js/monetize.js, so
// it can both read the _RO/_EN pairs those files define and expose the
// final window.QUESTIONS/CHALLENGES/GAMES/DRAW_PROMPTS/TEMPLATE_* globals
// the rest of the app already expects — no other file needs to know
// language exists except where it shows dynamic text (see I18N.t below).
(() => {
  "use strict";

  const LANG_KEY = "8ish_lang_v1";

  function readLang() {
    try {
      const stored = localStorage.getItem(LANG_KEY);
      return stored === "en" ? "en" : "ro";
    } catch (e) {
      return "ro";
    }
  }

  function writeLang(lang) {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch (e) {
      /* private mode / storage unavailable — language just won't persist */
    }
  }

  const lang = readLang();

  // --- content bank selection --------------------------------------------
  // Each content file defines window.X_RO and window.X_EN; resolve to the
  // plain window.X name the rest of the app (app.js, draw.js) already uses,
  // unchanged, so this is the only file that needs to know about _RO/_EN.
  window.QUESTIONS = lang === "en" ? window.QUESTIONS_EN : window.QUESTIONS_RO;
  window.CHALLENGES = lang === "en" ? window.CHALLENGES_EN : window.CHALLENGES_RO;
  window.GAMES = lang === "en" ? window.GAMES_EN : window.GAMES_RO;
  window.DRAW_PROMPTS = lang === "en" ? window.DRAW_PROMPTS_EN : window.DRAW_PROMPTS_RO;
  window.TEMPLATE_LETTERS = lang === "en" ? window.TEMPLATE_LETTERS_EN : window.TEMPLATE_LETTERS_RO;
  window.TEMPLATE_CATEGORIES = lang === "en" ? window.TEMPLATE_CATEGORIES_EN : window.TEMPLATE_CATEGORIES_RO;
  window.TEMPLATE_COLORS = lang === "en" ? window.TEMPLATE_COLORS_EN : window.TEMPLATE_COLORS_RO;

  // --- UI chrome dictionary ------------------------------------------------
  // Static text applies via [data-i18n]/[data-i18n-aria]/[data-i18n-placeholder]
  // attributes in index.html (see applyStaticText below); dynamic text (status
  // messages, error strings set from JS) uses I18N.t(key) directly.
  const STRINGS = {
    ro: {
      eyebrowHome: "Cartonașe cu întrebări",
      modeQuestions: "Întrebări",
      modeChallenges: "Provocări",
      modeGames: "Jocuri",
      modeDraw: "Desenează",
      homeHint: "Atinge ecranul pentru următoarea. Atinge Gata când termini.",
      parentModeBtn: "Pentru părinți",
      backBtn: "‹ Înapoi",
      "parent.backBtn": "‹ Înapoi",
      backToGamesBtn: "‹ Jocuri",
      gamesTitle: "Alege un joc",
      howToPlay: "Cum se joacă",
      endSessionAria: "Încheie sesiunea",
      doneBtn: "Gata",
      nextCardAria: "Arată următoarea",
      startTimerAria: "Pornește cronometrul",
      tapForNext: "Atinge pentru următoarea",
      drawEyebrow: "Desenează",
      drawStartBtn: "Desenează!",
      drawRerollBtn: "Altă provocare!",
      endDrawingAria: "Încheie desenul",
      clearBtn: "Șterge",
      finishBtn: "Termină!",
      endAria: "Încheie",
      drawCreating: "Se creează opera ta…",
      drawArtworkAlt: "Opera ta de artă",
      drawOriginalAlt: "Desenul tău original",
      showOriginalAria: "Arată desenul original",
      showArtworkAria: "Arată opera ta",
      saveBtn: "Salvează!",
      newDrawingBtn: "Desen nou",
      retryBtn: "Mai încearcă!",
      dailyLimitEyebrow: "Gata pentru azi!",
      dailyLimitText: "Ai terminat cele {count} activități gratuite de azi.",
      dailyLimitSubtext: "Revino mâine pentru încă activități.",
      comeBackTomorrow: "Revin mâine",
      "parent.gateEyebrow": "Pentru părinți",
      "parent.answerAria": "Răspuns",
      "parent.gateWrong": "Nu e corect, mai încearcă.",
      "parent.continueBtn": "Continuă",
      "parent.paywallEyebrow": "8ish+",
      "parent.paywallHeadline": "Activități nelimitate",
      "parent.paywallIncluded": "Ce primești: Activități nelimitate + până la 10 Imagini pe zi",
      "parent.paywallRenewalNote":
        "Reînnoire automată la sfârșitul perioadei (lunar sau anual, după planul ales). Anulezi oricând, fără email, din ecranul Pentru părinți.",
      // Story 6.5: singurul mesaj afișat când prețul unui plan (sau al
      // ambelor) nu poate fi confirmat de la Stripe — butoanele de
      // cumpărare rămân dezactivate, niciun preț ghicit nu e afișat.
      "parent.pricingUnavailable": "Prețurile nu sunt disponibile momentan. Încearcă din nou mai târziu.",
      "parent.planMonthly": "Lunar",
      "parent.planYearly": "Anual",
      "parent.alreadySubscribed": "Am deja abonament",
      termsLink: "Termeni",
      "parent.termsLink": "Termeni",
      privacyLink: "Confidențialitate",
      "parent.privacyLink": "Confidențialitate",
      "parent.subscriptionActive": "Abonament activ",
      "parent.restoreCodeLabel": "Codul tău de recuperare:",
      "parent.restoreEyebrow": "Recuperează 8ish+",
      "parent.restoreIntro": "Introdu emailul și codul primite la abonare",
      "parent.emailAria": "Email",
      "parent.emailPlaceholder": "email@exemplu.com",
      "parent.restoreCodeAria": "Cod de recuperare",
      "parent.humanCheckAria": "Verificare de securitate",
      // Story 6.3: un singur mesaj generic pentru orice eșec la recuperare —
      // email/cod greșit, verificare de securitate eșuată/lipsă sau o
      // problemă de rețea arată identic, ca să nu poată fi folosit pentru a
      // ghici emailuri sau coduri valide.
      "parent.restoreFailed": "Nu am putut recupera abonamentul. Încearcă din nou.",
      "parent.restoreBtn": "Recuperează",
      "parent.restoreCodeRevealEyebrow": "8ish+ activat! 🎉",
      "parent.restoreCodeRevealHeadline": "Salvează acest cod",
      "parent.restoreCodeRevealSubtext": "Ai nevoie de el (împreună cu emailul folosit la abonare) ca să recuperezi abonamentul pe alt dispozitiv.",
      "parent.restoreCodeNoted": "Am notat codul",
      "parent.loading": "Un moment...",
      "parent.checkoutFailed": "Nu am putut porni plata. Încearcă din nou.",
      "parent.renewalUnavailable": "Data reînnoirii nu este disponibilă momentan.",
      "parent.renewsOn": "Se reînnoiește pe ",
      "parent.dateLocale": "ro-RO",
      // Story 6.6: Cancel/Resume, two-tap confirm-in-place (see monetize.js).
      "parent.cancelBtn": "Anulează abonamentul",
      "parent.cancelConfirmBtn": "Apasă din nou pentru confirmare",
      "parent.resumeBtn": "Reactivează abonamentul",
      "parent.accessEndsOn": "Acces până la {date}",
      "parent.subscriptionActionFailed": "Nu am putut actualiza abonamentul. Încearcă din nou.",
      drawProviderError: "Hopa! Ceva nu a mers bine. Mai încearcă!",
      drawOffline: "Ai nevoie de internet ca desenul tău să prindă viață. Încearcă din nou!",
      drawDailyLimit: "Creatorul de imagini a terminat pentru azi. Revino mâine!",
      drawWait: "Așteaptă {seconds} secunde și încearcă din nou!",
      drawResting: "Creatorul de imagini se odihnește până mâine. Revino atunci!",
      langToggle: "EN",
      freeCounterText: "{remaining} din {total} activități rămase azi",
      "parent.perMonth": "/lună",
      "parent.perYear": "/an",
    },
    en: {
      eyebrowHome: "Question Cards",
      modeQuestions: "Questions",
      modeChallenges: "Challenges",
      modeGames: "Games",
      modeDraw: "Draw",
      homeHint: "Tap the screen for the next one. Tap Done when you finish.",
      parentModeBtn: "For parents",
      backBtn: "‹ Back",
      "parent.backBtn": "‹ Back",
      backToGamesBtn: "‹ Games",
      gamesTitle: "Pick a game",
      howToPlay: "How to play",
      endSessionAria: "End session",
      doneBtn: "Done",
      nextCardAria: "Show next",
      startTimerAria: "Start timer",
      tapForNext: "Tap for the next one",
      drawEyebrow: "Draw",
      drawStartBtn: "Draw!",
      drawRerollBtn: "Another challenge!",
      endDrawingAria: "End drawing",
      clearBtn: "Clear",
      finishBtn: "Finish!",
      endAria: "Done",
      drawCreating: "Creating your masterpiece…",
      drawArtworkAlt: "Your artwork",
      drawOriginalAlt: "Your original drawing",
      showOriginalAria: "Show original drawing",
      showArtworkAria: "Show artwork",
      saveBtn: "Save!",
      newDrawingBtn: "New drawing",
      retryBtn: "Try again!",
      dailyLimitEyebrow: "Done for today!",
      dailyLimitText: "You've finished today's {count} free activities.",
      dailyLimitSubtext: "Come back tomorrow for more.",
      comeBackTomorrow: "Come back tomorrow",
      "parent.gateEyebrow": "For parents",
      "parent.answerAria": "Answer",
      "parent.gateWrong": "Not quite, try again.",
      "parent.continueBtn": "Continue",
      "parent.paywallEyebrow": "8ish+",
      "parent.paywallHeadline": "Unlimited activities",
      "parent.paywallIncluded": "What's included: Unlimited Activities + up to 10 Images a day",
      "parent.paywallRenewalNote":
        "Renews automatically at the end of each billing period (monthly or yearly, based on your plan). Cancel any time, no email needed, from the For Parents screen.",
      // Story 6.5: the one message shown when a plan's price (or both)
      // can't be confirmed from Stripe — the buy buttons stay disabled, no
      // guessed price is ever shown.
      "parent.pricingUnavailable": "Prices aren't available right now. Please try again later.",
      "parent.planMonthly": "Monthly",
      "parent.planYearly": "Yearly",
      "parent.alreadySubscribed": "I already subscribed",
      termsLink: "Terms",
      "parent.termsLink": "Terms",
      privacyLink: "Privacy",
      "parent.privacyLink": "Privacy",
      "parent.subscriptionActive": "Subscription active",
      "parent.restoreCodeLabel": "Your recovery code:",
      "parent.restoreEyebrow": "Restore 8ish+",
      "parent.restoreIntro": "Enter the email and code from when you subscribed",
      "parent.emailAria": "Email",
      "parent.emailPlaceholder": "email@example.com",
      "parent.restoreCodeAria": "Recovery code",
      "parent.humanCheckAria": "Security check",
      // Story 6.3: one generic message for any restore failure — a wrong
      // email/code, a failed or missing human check, or a network problem
      // all look identical, so this can't be used to probe for valid
      // emails or codes.
      "parent.restoreFailed": "We couldn't restore your subscription. Please try again.",
      "parent.restoreBtn": "Restore",
      "parent.restoreCodeRevealEyebrow": "8ish+ activated! 🎉",
      "parent.restoreCodeRevealHeadline": "Save this code",
      "parent.restoreCodeRevealSubtext": "You'll need it (along with the email you subscribed with) to restore your subscription on another device.",
      "parent.restoreCodeNoted": "I've saved the code",
      "parent.loading": "One moment...",
      "parent.checkoutFailed": "We couldn't start checkout. Please try again.",
      "parent.renewalUnavailable": "Renewal date isn't available right now.",
      "parent.renewsOn": "Renews on ",
      "parent.dateLocale": "en-US",
      // Story 6.6: Cancel/Resume, two-tap confirm-in-place (see monetize.js).
      "parent.cancelBtn": "Cancel subscription",
      "parent.cancelConfirmBtn": "Tap again to confirm",
      "parent.resumeBtn": "Resume subscription",
      "parent.accessEndsOn": "Access ends on {date}",
      "parent.subscriptionActionFailed": "We couldn't update your subscription. Please try again.",
      drawProviderError: "Oops! Something went wrong. Try again!",
      drawOffline: "You need internet for your drawing to come to life. Try again!",
      drawDailyLimit: "The picture maker is done for today. Come back tomorrow!",
      drawWait: "Wait {seconds} seconds and try again!",
      drawResting: "The picture maker is resting until tomorrow. Come back then!",
      langToggle: "RO",
      freeCounterText: "{remaining} of {total} free activities left today",
      "parent.perMonth": "/month",
      "parent.perYear": "/year",
    },
  };

  function t(key) {
    return (STRINGS[lang] && STRINGS[lang][key]) || (STRINGS.ro[key] ?? key);
  }

  // Applies every [data-i18n]/[data-i18n-aria]/[data-i18n-placeholder]
  // element's text/attribute from the dictionary — run once on load, since
  // switching language reloads the page (see toggleLang below) rather than
  // trying to live-update every visible screen's dynamic state.
  function applyStaticText() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
      el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
      el.setAttribute("alt", t(el.getAttribute("data-i18n-alt")));
    });
    document.documentElement.lang = lang;
  }

  function toggleLang() {
    writeLang(lang === "en" ? "ro" : "en");
    window.location.reload();
  }

  function wireLangToggle() {
    const btn = document.getElementById("langToggleBtn");
    if (btn) btn.addEventListener("click", toggleLang);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      applyStaticText();
      wireLangToggle();
    });
  } else {
    applyStaticText();
    wireLangToggle();
  }

  window.I18N = { lang, t, toggleLang };
})();
