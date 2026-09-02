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
      dailyLimitSubtext: "Revino mâine pentru încă activități sau roagă un părinte să deblocheze 8ish+.",
      comeBackTomorrow: "Revin mâine",
      parentGateEyebrow: "Pentru părinți",
      answerAria: "Răspuns",
      parentGateWrong: "Nu e corect, mai încearcă.",
      continueBtn: "Continuă",
      paywallEyebrow: "8ish+",
      paywallHeadline: "Activități nelimitate",
      planMonthly: "Lunar",
      planYearly: "Anual",
      alreadySubscribed: "Am deja abonament",
      termsLink: "Termeni",
      privacyLink: "Confidențialitate",
      subscriptionActive: "Abonament activ",
      restoreCodeLabel: "Codul tău de recuperare:",
      restoreEyebrow: "Recuperează 8ish+",
      restoreIntro: "Introdu emailul și codul primite la abonare",
      emailAria: "Email",
      emailPlaceholder: "email@exemplu.com",
      restoreCodeAria: "Cod de recuperare",
      restoreError: "Nu am găsit un abonament activ pentru acest email și cod.",
      restoreBtn: "Recuperează",
      restoreCodeRevealEyebrow: "8ish+ activat! 🎉",
      restoreCodeRevealHeadline: "Salvează acest cod",
      restoreCodeRevealSubtext: "Ai nevoie de el (împreună cu emailul folosit la abonare) ca să recuperezi abonamentul pe alt dispozitiv.",
      restoreCodeNoted: "Am notat codul",
      loading: "Un moment...",
      checkoutFailed: "Nu am putut porni plata. Încearcă din nou.",
      renewalUnavailable: "Data reînnoirii nu este disponibilă momentan.",
      renewsOn: "Se reînnoiește pe ",
      dateLocale: "ro-RO",
      drawCooldown: "Așteaptă puțin și mai încearcă o dată!",
      drawProviderError: "Hopa! Ceva nu a mers bine. Mai încearcă!",
      drawOffline: "Ai nevoie de internet ca desenul tău să prindă viață. Încearcă din nou!",
      drawAiLimit: "Ai folosit desenul AI gratuit de azi. Roagă un părinte să deblocheze 8ish+ pentru mai multe!",
      langToggle: "EN",
      freeCounterText: "{remaining} din {total} activități rămase azi",
      perMonth: "/lună",
      perYear: "/an",
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
      dailyLimitSubtext: "Come back tomorrow for more, or ask a parent to unlock 8ish+.",
      comeBackTomorrow: "Come back tomorrow",
      parentGateEyebrow: "For parents",
      answerAria: "Answer",
      parentGateWrong: "Not quite, try again.",
      continueBtn: "Continue",
      paywallEyebrow: "8ish+",
      paywallHeadline: "Unlimited activities",
      planMonthly: "Monthly",
      planYearly: "Yearly",
      alreadySubscribed: "I already subscribed",
      termsLink: "Terms",
      privacyLink: "Privacy",
      subscriptionActive: "Subscription active",
      restoreCodeLabel: "Your recovery code:",
      restoreEyebrow: "Restore 8ish+",
      restoreIntro: "Enter the email and code from when you subscribed",
      emailAria: "Email",
      emailPlaceholder: "email@example.com",
      restoreCodeAria: "Recovery code",
      restoreError: "We couldn't find an active subscription for that email and code.",
      restoreBtn: "Restore",
      restoreCodeRevealEyebrow: "8ish+ activated! 🎉",
      restoreCodeRevealHeadline: "Save this code",
      restoreCodeRevealSubtext: "You'll need it (along with the email you subscribed with) to restore your subscription on another device.",
      restoreCodeNoted: "I've saved the code",
      loading: "One moment...",
      checkoutFailed: "We couldn't start checkout. Please try again.",
      renewalUnavailable: "Renewal date isn't available right now.",
      renewsOn: "Renews on ",
      dateLocale: "en-US",
      drawCooldown: "Hang on a moment and try again!",
      drawProviderError: "Oops! Something went wrong. Try again!",
      drawOffline: "You need internet for your drawing to come to life. Try again!",
      drawAiLimit: "You've used today's free AI drawing. Ask a parent to unlock 8ish+ for more!",
      langToggle: "RO",
      freeCounterText: "{remaining} of {total} free activities left today",
      perMonth: "/month",
      perYear: "/year",
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
