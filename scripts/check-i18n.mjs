// Keeps purchase language off the child screens and keeps the Romanian and
// English text in step. Reads the real i18n.js, index.html and the scripts
// index.html loads, and fails when:
//   - a child-facing string or default text has a purchase stem (buy, unlock,
//     subscribe, premium, ask a parent, cumpar, deblocheaz, abon, plat,
//     cere/roaga ... parinte)
//   - a key exists in one language only
//   - a data-i18n* attribute, t("...") literal or draw.js message-map key is
//     not defined in both languages (it would render as raw text)
//   - a parent.* key is used on a child screen or in app.js/draw.js/ui.js, or a
//     non-parent. key (except parentModeBtn) is used on a parent-only screen
// Then it runs built-in good and bad fixtures to prove it fails and passes
// correctly. No dependencies, Node 18+.
//
//   node scripts/check-i18n.mjs
//
// Exits 0 when everything passes, 1 otherwise. Run by hand until Epic 4.4
// wires it into the pipeline.
//
// To add a purchase stem: add an entry to STEMS (a regex on text that is
// already lower-cased with accents removed) and a sample to STEM_SAMPLES.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

// The one place that names the client folder: everything the site publishes
// lives in public/ (wrangler.jsonc assets.directory).
const CLIENT_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const HTML_FILE = "index.html";
const I18N_FILE = "i18n.js";
const LANGS = ["ro", "en"];

// The <div id="..."> screens only a parent sees. Everything else in
// index.html is child-facing.
const PARENT_SCREENS = ["parentGate", "parentsHub", "paywall", "restore", "restoreCodeReveal"];
const PARENT_PREFIX = "parent.";
// The one key without the prefix that a parent-only screen may use (it is the
// "For parents" button label, which also sits on child screens).
const ALLOWED_UNPREFIXED = "parentModeBtn";
// The only scripts that may look up parent.* keys.
const PARENT_SCRIPTS = ["monetize.js"];
// The script whose object literal maps failure kinds to key names.
const MESSAGE_MAP_FILE = "draw.js";
const MESSAGE_MAP_NAME = "RESULT_MESSAGE_KEYS";

// Purchase stems, matched on normalized text (lower case, accents removed, so
// "Cumpără" is "cumpara"). `plat` is broad by design: a false hit on a child
// string is fixed by rewording it.
const STEMS = [
  { name: "buy", lang: "en", re: /\bbuy/ },
  { name: "unlock", lang: "en", re: /\bunlock/ },
  { name: "subscri", lang: "en", re: /\bsubscri/ },
  { name: "premium", lang: "en", re: /\bpremium/ },
  { name: "ask a parent", lang: "en", re: /\bask\b.{0,30}\bparent/ },
  { name: "cumpar", lang: "ro", re: /\bcumpar/ },
  { name: "deblocheaz", lang: "ro", re: /\bdeblocheaz/ },
  { name: "abon", lang: "ro", re: /\babon/ },
  { name: "plat", lang: "ro", re: /\bplat/ },
  { name: "cere/roaga ... parinte", lang: "ro", re: /\b(?:cere|roag)\w*\b.{0,40}\bparint/ },
];

const normalize = (text) =>
  String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");

function findStems(text) {
  const n = normalize(text);
  const hits = [];
  for (const stem of STEMS) {
    const m = stem.re.exec(n);
    if (m) hits.push({ stem, matched: m[0] });
  }
  return hits;
}

const clip = (text, max = 80) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// ------------------------------------------------------------------- reading

// Runs the real i18n.js in a sandbox with a tiny fake window/document/
// localStorage and hands back STRINGS by patching the `function t(key)` line.
function readDictionary(source) {
  const marker = /function\s+t\s*\(\s*key\s*\)\s*\{/;
  if (!marker.test(source)) {
    throw new Error(`${I18N_FILE}: cannot find the "function t(key)" line that lets this check read STRINGS (did the file's shape change?)`);
  }
  const patched = source.replace(marker, (line) => `globalThis.__STRINGS = STRINGS; ${line}`);
  const noop = () => {};
  const sandbox = {
    window: {},
    localStorage: { getItem: () => null, setItem: noop },
    document: {
      readyState: "complete",
      documentElement: {},
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: noop,
    },
    console,
  };
  try {
    vm.runInNewContext(patched, sandbox, { filename: I18N_FILE, timeout: 2000 });
  } catch (error) {
    throw new Error(`${I18N_FILE}: running it in the sandbox failed: ${error && error.message}`);
  }
  const raw = sandbox.__STRINGS;
  if (!raw || typeof raw !== "object") throw new Error(`${I18N_FILE}: STRINGS was not found`);
  const dict = {};
  const problems = []; // values that are not usable text
  for (const lang of LANGS) {
    if (!raw[lang] || typeof raw[lang] !== "object") throw new Error(`${I18N_FILE}: STRINGS.${lang} is missing`);
    dict[lang] = Object.create(null);
    for (const key of Object.keys(raw[lang])) {
      const value = raw[lang][key];
      if (typeof value !== "string") {
        problems.push(`key "${key}" [${lang}]: value is not a string (${value === null ? "null" : typeof value})`);
      } else if (!value.trim()) {
        problems.push(`key "${key}" [${lang}]: value is empty`);
      }
      dict[lang][key] = String(value);
    }
  }
  return { dict, problems };
}

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// The {placeholder} tokens in a string, sorted and de-duplicated.
const placeholders = (text) => [...new Set(text.match(/\{[^{}]*\}/g) || [])].sort();

const I18N_ATTRS = ["data-i18n", "data-i18n-aria", "data-i18n-placeholder", "data-i18n-alt"];
const TEXT_ATTRS = ["aria-label", "alt", "placeholder", "title"];

function parseAttrs(body) {
  const attrs = {};
  for (const m of body.matchAll(/([^\s=\/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

// One pass over index.html (comments, <script> and <style> removed). Tracks
// which parent-only <div> we are inside by counting nested div tags. Returns
//   texts: text nodes and text attributes outside the parent-only screens
//   refs:  every data-i18n* key with where it is and which area it is in
//   problems: things that make the scan untrustworthy
function scanHtml(html) {
  const src = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const texts = [];
  const refs = [];
  const problems = [];
  const seen = new Set();
  let area = null; // id of the parent-only screen we are in, else null
  let depth = 0;
  let last = 0;
  let lastTag = "the page";

  const flushText = (raw) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (text && area === null) texts.push({ text, where: `text in ${lastTag}` });
  };

  for (const m of src.matchAll(tagRe)) {
    flushText(src.slice(last, m.index));
    last = m.index + m[0].length;

    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = parseAttrs(m[3]);
    const selfClosing = /\/\s*$/.test(m[3]);
    const desc = attrs.id ? `<${name} #${attrs.id}>` : `<${name}>`;

    if (name === "div") {
      if (closing) {
        if (area !== null && --depth === 0) area = null;
      } else if (area === null && PARENT_SCREENS.includes(attrs.id) && !selfClosing) {
        area = attrs.id;
        depth = 1;
        seen.add(attrs.id);
      } else if (area !== null && !selfClosing) {
        depth++;
      }
    }
    if (closing) {
      lastTag = "the page";
      continue;
    }
    lastTag = desc;

    for (const attr of I18N_ATTRS) {
      if (attr in attrs) refs.push({ key: attrs[attr].trim(), where: `${HTML_FILE} ${attr} on ${desc}${area ? ` in #${area}` : ""}`, area });
    }
    if (area === null) {
      for (const attr of TEXT_ATTRS) {
        if (attrs[attr]) texts.push({ text: attrs[attr].replace(/\s+/g, " ").trim(), where: `${attr} on ${desc}` });
      }
    }
  }
  flushText(src.slice(last));

  for (const id of PARENT_SCREENS) {
    if (!seen.has(id)) problems.push(`${HTML_FILE}: parent-only screen <div id="${id}"> not found`);
  }
  if (area !== null) problems.push(`${HTML_FILE}: parent-only screen <div id="${area}"> is never closed`);
  return { texts, refs, problems };
}

// Literal keys in t("...") and I18N.t("..."), plus the draw.js message map.
function scanScripts(scripts) {
  const refs = [];
  const problems = [];
  const call = /(?:\bI18N\s*\.\s*t|(?<![\w$.])t)\s*\(\s*(["'])([^"'\\\n]+)\1\s*[,)]/g;
  for (const [file, src] of Object.entries(scripts)) {
    for (const m of src.matchAll(call)) {
      refs.push({ key: m[2], file, where: `${file}:${lineOf(src, m.index)} t()` });
    }
  }
  if (typeof scripts[MESSAGE_MAP_FILE] !== "string") {
    problems.push(`${MESSAGE_MAP_FILE}: not loaded, so its ${MESSAGE_MAP_NAME} keys cannot be checked`);
  } else {
    const src = scripts[MESSAGE_MAP_FILE];
    const map = new RegExp(`${MESSAGE_MAP_NAME}\\s*=\\s*\\{([^}]*)\\}`).exec(src);
    if (!map) {
      problems.push(`${MESSAGE_MAP_FILE}: ${MESSAGE_MAP_NAME} object literal not found, so its keys cannot be checked`);
    } else {
      const bodyStart = map.index + map[0].indexOf("{") + 1;
      for (const e of map[1].matchAll(/["']?[\w$]+["']?\s*:\s*(["'])([^"'\\\n]+)\1/g)) {
        refs.push({ key: e[2], file: MESSAGE_MAP_FILE, where: `${MESSAGE_MAP_FILE}:${lineOf(src, bodyStart + e.index)} ${MESSAGE_MAP_NAME}` });
      }
    }
  }
  return { refs, problems };
}

// ------------------------------------------------------------------- checks

const CHECKS = {
  sources: "sources read: i18n.js dictionary, index.html with its five parent-only screens, the scripts and their key references",
  dictionary: "every RO and EN value is non-empty text, with the same {placeholders} in both languages",
  childStrings: "child-facing strings (every non-parent. key, RO and EN) have no purchase language",
  childHtml: "child-facing default text in index.html has no purchase language",
  parity: "RO and EN have the same keys",
  references: "every data-i18n* and t() key, and every draw.js message key, is defined in RO and EN",
  namespace: "parent.* keys stay on parent-only screens and in monetize.js; parent-only screens use only parent.* keys",
};

const isParentKey = (key) => key.startsWith(PARENT_PREFIX);

// One function over a source bundle: { i18n, html, scripts: { "app.js": src } }.
// options.requiredScripts: script names that must be in the bundle (the real
// run passes REQUIRED_SCRIPTS so a loader that finds nothing cannot pass).
// Returns { results: [{ id, problems }], unused: [key] }.
function runChecks(bundle, { requiredScripts = [] } = {}) {
  const results = [];
  const add = (id, problems) => results.push({ id, problems });

  const scripts = bundle.scripts || {};
  const missingScripts = requiredScripts
    .filter((file) => typeof scripts[file] !== "string")
    .map((file) => `${file}: required script was not loaded from ${HTML_FILE}, so it was not scanned`);

  let dict;
  let dictProblems;
  try {
    ({ dict, problems: dictProblems } = readDictionary(bundle.i18n));
  } catch (error) {
    add("sources", [String(error.message || error), ...missingScripts]);
    return { results, unused: [] };
  }
  const html = scanHtml(bundle.html);
  const script = scanScripts(scripts);
  add("sources", [...html.problems, ...script.problems, ...missingScripts]);

  // Values are text, and the {placeholders} match between languages.
  const dictionaryProblems = [...dictProblems];
  for (const key of Object.keys(dict.ro)) {
    if (!has(dict.en, key)) continue;
    const [ro, en] = [placeholders(dict.ro[key]), placeholders(dict.en[key])];
    if (ro.join() !== en.join()) {
      dictionaryProblems.push(`key "${key}": placeholders differ: RO ${ro.join(" ") || "(none)"}, EN ${en.join(" ") || "(none)"}`);
    }
  }
  add("dictionary", dictionaryProblems);

  // Purchase stems in child-facing dictionary strings.
  const stemProblems = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(dict[lang])) {
      if (isParentKey(key)) continue;
      for (const hit of findStems(value)) {
        stemProblems.push(`key "${key}" [${lang}]: purchase stem "${hit.stem.name}" (matched "${hit.matched}") in "${clip(value)}"`);
      }
    }
  }
  add("childStrings", stemProblems);

  // Purchase stems in child-facing default text.
  const textProblems = [];
  for (const { text, where } of html.texts) {
    for (const hit of findStems(text)) {
      textProblems.push(`${HTML_FILE} ${where} [${hit.stem.lang} stem]: purchase stem "${hit.stem.name}" (matched "${hit.matched}") in "${clip(text)}"`);
    }
  }
  add("childHtml", textProblems);

  // Same key set in both languages.
  const parityProblems = [];
  for (const lang of LANGS) {
    const other = LANGS.find((l) => l !== lang);
    for (const key of Object.keys(dict[lang])) {
      if (!has(dict[other], key)) parityProblems.push(`key "${key}" is in ${lang.toUpperCase()} but missing from ${other.toUpperCase()}`);
    }
  }
  add("parity", parityProblems);

  // Every used key resolves in both languages.
  const uses = new Map(); // key -> [where]
  for (const ref of [...html.refs, ...script.refs]) {
    if (!uses.has(ref.key)) uses.set(ref.key, []);
    uses.get(ref.key).push(ref.where);
  }
  const refProblems = [];
  for (const [key, places] of uses) {
    const missing = LANGS.filter((lang) => !has(dict[lang], key));
    if (!missing.length) continue;
    const shown = places.slice(0, 3).join("; ") + (places.length > 3 ? `; +${places.length - 3} more` : "");
    refProblems.push(`key "${key}" is not defined in ${missing.map((l) => l.toUpperCase()).join(" and ")} (used: ${shown})`);
  }
  add("references", refProblems);

  // parent.* only on parent-only screens (and in monetize.js).
  const nsProblems = [];
  for (const ref of html.refs) {
    if (ref.area === null && isParentKey(ref.key)) {
      nsProblems.push(`key "${ref.key}" is a parent. key on a child element (${ref.where})`);
    } else if (ref.area !== null && !isParentKey(ref.key) && ref.key !== ALLOWED_UNPREFIXED) {
      nsProblems.push(`key "${ref.key}" is not a parent. key but is on parent-only screen #${ref.area} (${ref.where})`);
    }
  }
  for (const ref of script.refs) {
    if (isParentKey(ref.key) && !PARENT_SCRIPTS.includes(ref.file)) {
      nsProblems.push(`key "${ref.key}" is a parent. key looked up in ${ref.where}; only ${PARENT_SCRIPTS.join(", ")} may`);
    }
  }
  add("namespace", nsProblems);

  const unused = [...new Set(LANGS.flatMap((lang) => Object.keys(dict[lang])))].filter((key) => !uses.has(key)).sort();
  return { results, unused };
}

// ------------------------------------------------------------------ real files

// The scripts the real run must have loaded; if the loader finds fewer, the
// check would be scanning nothing, so the sources check fails.
const REQUIRED_SCRIPTS = ["app.js", "ui.js", "draw.js", "monetize.js"];

// Local script files index.html loads, in order, as file names: query string
// and #hash removed, leading "./" or "/" removed, i18n.js and remote URLs left
// out. Handles quoted and unquoted src values and ignores data-src.
function scriptNames(html) {
  const names = [];
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const src = parseAttrs(m[1]).src;
    if (!src) continue;
    const ref = src.trim().replace(/[?#].*$/, "").replace(/^\.?\//, "");
    if (!ref || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(src.trim()) || ref === I18N_FILE || names.includes(ref)) continue;
    names.push(ref);
  }
  return names;
}

function loadBundle(dir = CLIENT_DIR) {
  const read = (file) => readFileSync(path.join(dir, file), "utf8");
  const html = read(HTML_FILE);
  const scripts = {};
  for (const name of scriptNames(html)) scripts[name] = read(name);
  return { i18n: read(I18N_FILE), html, scripts };
}

// ------------------------------------------------------------------ fixtures

const mkI18n = (ro, en) =>
  `(() => { const STRINGS = ${JSON.stringify({ ro, en })}; function t(key) { return STRINGS.ro[key]; } window.I18N = { t }; })();`;

// `after` sits after the five parent-only screens, to prove the div counting
// ends each screen where it should.
// `late` goes into #paywall; `hideScreen` leaves one parent-only screen out.
const mkPage = ({ child, parent, after, late = "", hideScreen = "" }) => `<!doctype html>
<html lang="ro"><head><title>8ish</title><style>.x { content: "Buy"; }</style></head>
<body>
<!-- Buy Unlock Subscribe: comments are ignored -->
<main id="start">${child}</main>
${PARENT_SCREENS.filter((id) => id !== hideScreen)
  .map((id) => `<div id="${id}" class="screen" hidden>${id === "parentGate" ? parent : id === "paywall" ? late : ""}</div>`)
  .join("\n")}
<footer>${after}</footer>
<script>const s = "Buy now";</script>
<script src="i18n.js"></script>
</body></html>`;

const baseSpec = () => ({
  ro: {
    brand: "8ish+",
    modeQuestions: "Întrebări",
    parentModeBtn: "Pentru părinți",
    freeCounterText: "{remaining} din {total} activități rămase azi",
    drawOffline: "Ai nevoie de internet. Încearcă din nou!",
    "parent.gateEyebrow": "Pentru părinți",
  },
  en: {
    brand: "8ish+",
    modeQuestions: "Questions",
    parentModeBtn: "For parents",
    freeCounterText: "{remaining} of {total} free activities left today",
    drawOffline: "You need internet. Try again!",
    "parent.gateEyebrow": "For parents",
  },
  child: `<p data-i18n="brand">8ish+</p>
    <button data-i18n="modeQuestions">Întrebări</button>
    <button data-i18n="parentModeBtn">Pentru părinți</button>`,
  parent: `<p data-i18n="parent.gateEyebrow">Pentru părinți</p>`,
  after: "Gata",
  scripts: {
    "app.js": `window.LIMIT.tryConsume(); const label = window.I18N.t("modeQuestions");`,
    "ui.js": `const kind = "ring"; foo.set("x"); bar.t.get("parent.gateEyebrow");`,
    "draw.js": `const ${MESSAGE_MAP_NAME} = {\n  offline: "drawOffline",\n};\nel.textContent = window.I18N.t(${MESSAGE_MAP_NAME}[kind]);`,
    "monetize.js": `const t = window.I18N.t;\nt("parent.gateEyebrow"); t("freeCounterText");`,
  },
});

const build = (spec) => ({
  i18n: mkI18n(spec.ro, spec.en),
  html: mkPage(spec),
  scripts: spec.scripts,
});

const fixtures = [];
// fails: { checkId: [text every problem list of that check must contain] }.
// The set of failing checks must equal the keys of `fails` exactly.
const fixture = (name, mutate, fails = {}, extra = {}) => {
  const spec = baseSpec();
  mutate(spec);
  fixtures.push({ name, bundle: build(spec), fails, ...extra });
};
const setBoth = (spec, key, ro, en = ro) => {
  spec.ro[key] = ro;
  spec.en[key] = en;
};

fixture("good: base bundle passes", () => {});

fixture(
  "good: parent.* purchase wording, 8ish+ alone, 8ish+ ∞, parentModeBtn on a parent screen, clean child strings pass; unused key is information",
  (s) => {
    setBoth(s, "parent.subscribeBtn", "Abonează-te acum și deblochează tot", "Subscribe and unlock everything");
    setBoth(s, "parent.buyNote", "Plătește lunar sau anual", "Buy monthly or yearly. Ask a parent to pay for premium.");
    setBoth(s, "counter", "8ish+ ∞");
    setBoth(s, "unusedThing", "Nefolosit", "Unused");
    for (const [ro, en, key] of [
      ["Pentru părinți", "For parents", "c1"],
      ["Gata pentru azi!", "Done for today!", "c2"],
      ["Revino mâine", "Come back tomorrow", "c3"],
      ["Ai terminat cele {count} activități gratuite de azi.", "You've finished today's {count} free activities.", "c4"],
      ["Se creează opera ta…", "Creating your masterpiece…", "c5"],
      ["Arată desenul original", "Show original drawing", "c6"],
      ["Așteaptă puțin și mai încearcă o dată!", "Hang on a moment and try again!", "c7"],
    ]) {
      setBoth(s, key, ro, en);
    }
    s.child += `<p data-i18n="counter">8ish+ ∞</p>`;
    s.parent = `<p data-i18n="parent.subscribeBtn">Abonează-te</p>
      <p data-i18n="parent.buyNote">Cumpără</p>
      <button data-i18n="parentModeBtn">Pentru părinți</button>
      <div><div><span>Subscribe, unlock, buy premium, ask a parent</span></div></div>`;
  },
  {},
  { unused: ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "unusedThing"] }
);

// One bad fixture per stem, in the language it belongs to. The child key is
// named "probe"; each fixture must print the key, the language and the stem.
const STEM_SAMPLES = [
  ["en", "Buy more activities", "buy"],
  ["en", "BUY NOW", "buy"],
  ["en", "Unlock everything", "unlock"],
  ["en", "Subscribe today", "subscri"],
  ["en", "Go premium", "premium"],
  ["en", "Ask a parent", "ask a parent"],
  ["en", "Ask your mom or dad or a parent", "ask a parent"],
  ["ro", "Cumpără acum", "cumpar"],
  ["ro", "CUMPĂRĂ", "cumpar"],
  ["ro", "Deblochează tot", "deblocheaz"],
  ["ro", "Abonează-te", "abon"],
  ["ro", "Abonament lunar", "abon"],
  ["ro", "Plătește", "plat"],
  ["ro", "Plată sigură", "plat"],
  ["ro", "Cere-i unui părinte", "cere/roaga ... parinte"],
  ["ro", "Roagă un părinte", "cere/roaga ... parinte"],
  ["ro", "Cere părintelui tău să continue", "cere/roaga ... parinte"],
];
for (const [lang, text, stem] of STEM_SAMPLES) {
  fixture(
    `bad: child key [${lang}] "${text}" -> stem ${stem}`,
    (s) => {
      s.ro.probe = "Ceva simplu";
      s.en.probe = "Something simple";
      s[lang].probe = text;
    },
    { childStrings: ['key "probe"', `[${lang}]`, `stem "${stem}"`] }
  );
}

fixture("bad: child default text in index.html", (s) => (s.child += `<p>Unlock more</p>`), {
  childHtml: ["index.html", 'stem "unlock"', "Unlock more", "text in <p>"],
});
fixture("bad: child default text, Romanian, with diacritics", (s) => (s.child += `<button id="go">Deblochează tot</button>`), {
  childHtml: ['stem "deblocheaz"', "#go"],
});
fixture("bad: child aria-label", (s) => (s.child += `<button id="a" aria-label="Cumpără">x</button>`), {
  childHtml: ["aria-label on <button #a>", 'stem "cumpar"'],
});
fixture("bad: child alt", (s) => (s.child += `<img alt="Buy now" src="x.png">`), { childHtml: ["alt on <img>", 'stem "buy"'] });
fixture("bad: child placeholder", (s) => (s.child += `<input placeholder="Abonează-te">`), { childHtml: ["placeholder on <input>", 'stem "abon"'] });
fixture("bad: child title attribute", (s) => (s.child += `<p title="Premium">x</p>`), { childHtml: ["title on <p>", 'stem "premium"'] });
fixture("bad: purchase text after the parent-only screens (nested divs counted right)", (s) => {
  s.parent = `<div><div>Subscribe and unlock</div></div><div>Buy</div>`;
  s.after = "Ask a parent to buy";
}, { childHtml: ['stem "ask a parent"', 'stem "buy"', "<footer>"] }, { excludes: { childHtml: ["Subscribe and unlock"] } });

fixture("bad: key in RO only", (s) => (s.ro.onlyRo = "Doar RO"), { parity: ['key "onlyRo" is in RO but missing from EN'] });
fixture("bad: key in EN only", (s) => (s.en.onlyEn = "Only EN"), { parity: ['key "onlyEn" is in EN but missing from RO'] });
fixture(
  "bad: used key deleted from EN",
  (s) => delete s.en.modeQuestions,
  { parity: ['key "modeQuestions" is in RO but missing from EN'], references: ['key "modeQuestions" is not defined in EN', "index.html data-i18n", "app.js"] }
);

fixture("bad: data-i18n key misspelled", (s) => (s.child += `<p data-i18n="modeQuestionz">x</p>`), {
  references: ['key "modeQuestionz" is not defined in RO and EN', "index.html data-i18n on <p>"],
});
fixture("bad: data-i18n-aria key misspelled", (s) => (s.child += `<p data-i18n-aria="nopeAria">x</p>`), {
  references: ['key "nopeAria"', "data-i18n-aria"],
});
fixture("bad: data-i18n-placeholder key misspelled", (s) => (s.child += `<input data-i18n-placeholder="nopePh">`), {
  references: ['key "nopePh"', "data-i18n-placeholder"],
});
fixture("bad: data-i18n-alt key misspelled", (s) => (s.child += `<img data-i18n-alt="nopeAlt">`), {
  references: ['key "nopeAlt"', "data-i18n-alt"],
});
fixture("bad: misspelled key on a parent-only screen", (s) => (s.parent += `<p id="pp" data-i18n="parent.gateEyebrowz">x</p>`), {
  references: ['key "parent.gateEyebrowz"', "<p #pp>", "#parentGate"],
});
fixture("bad: t() literal not defined", (s) => (s.scripts["monetize.js"] += `\nt("parent.restoreBtn");`), {
  references: ['key "parent.restoreBtn" is not defined in RO and EN', "monetize.js:3 t()"],
});
fixture("bad: I18N.t() literal not defined", (s) => (s.scripts["app.js"] += `\nwindow.I18N.t("nopeApp");`), {
  references: ['key "nopeApp"', "app.js:2 t()"],
});
fixture("bad: draw.js message-map key not defined", (s) => (s.scripts["draw.js"] = s.scripts["draw.js"].replace("};", '  cooldown: "drawCooldown",\n};')), {
  references: ['key "drawCooldown"', "draw.js:3 RESULT_MESSAGE_KEYS"],
});
fixture("bad: draw.js without its message map", (s) => (s.scripts["draw.js"] = `window.I18N.t("modeQuestions");`), {
  sources: [MESSAGE_MAP_NAME],
});

fixture("bad: parent. key on a child element", (s) => (s.child += `<p id="home" data-i18n="parent.gateEyebrow">x</p>`), {
  namespace: ['key "parent.gateEyebrow" is a parent. key on a child element', "<p #home>"],
});
fixture("bad: parent. key looked up in app.js", (s) => (s.scripts["app.js"] += `\nt("parent.gateEyebrow");`), {
  namespace: ['key "parent.gateEyebrow"', "app.js:2"],
});
fixture("bad: parent. key looked up in draw.js (message map)", (s) => {
  s.scripts["draw.js"] = s.scripts["draw.js"].replace('"drawOffline"', '"parent.gateEyebrow"');
}, { namespace: ['key "parent.gateEyebrow"', "draw.js:2"] });
fixture("bad: parent. key looked up in ui.js", (s) => (s.scripts["ui.js"] += `\nwindow.I18N.t("parent.gateEyebrow");`), {
  namespace: ['key "parent.gateEyebrow"', "ui.js:2"],
});
fixture("bad: non-parent. key on a parent-only screen", (s) => (s.parent += `<p id="pp" data-i18n="modeQuestions">x</p>`), {
  namespace: ['key "modeQuestions" is not a parent. key', "#parentGate", "<p #pp>"],
});
fixture("bad: non-parent. key on a later parent-only screen", (s) => {
  s.parent = `<p data-i18n="parent.gateEyebrow">x</p>`;
  s.late = `<p data-i18n="brand">8ish+</p>`;
}, { namespace: ['key "brand"', "#paywall"] });

fixture("bad: parent-only screen missing from index.html", (s) => (s.hideScreen = "restore"), { sources: ['<div id="restore"> not found'] });
fixtures.push({
  name: "bad: i18n.js without the function t(key) line",
  bundle: { ...build(baseSpec()), i18n: "const STRINGS = { ro: {}, en: {} };" },
  fails: { sources: ["function t(key)"] },
});
fixtures.push({
  name: "bad: i18n.js that throws when run",
  bundle: { ...build(baseSpec()), i18n: "throw new Error('boom'); function t(key) {}" },
  fails: { sources: ["boom"] },
});

// Nothing to scan must never look like a pass.
fixture("bad: no draw.js in the bundle", (s) => delete s.scripts["draw.js"], { sources: [MESSAGE_MAP_FILE, "not loaded"] });
fixtures.push({
  name: "bad: a required script (monetize.js) was not loaded",
  bundle: (() => {
    const spec = baseSpec();
    delete spec.scripts["monetize.js"];
    return build(spec);
  })(),
  options: { requiredScripts: REQUIRED_SCRIPTS },
  fails: { sources: ["monetize.js", "required script was not loaded"] },
});
fixtures.push({
  name: "good: all required scripts loaded",
  bundle: build(baseSpec()),
  options: { requiredScripts: REQUIRED_SCRIPTS },
  fails: {},
});

// Dictionary hygiene.
fixture("bad: a value that is not a string", (s) => ((s.ro.probeNum = "Unu"), (s.en.probeNum = 1)), {
  dictionary: ['key "probeNum" [en]', "not a string (number)"],
});
fixture("bad: a null value", (s) => ((s.ro.probeNull = null), (s.en.probeNull = "Null")), {
  dictionary: ['key "probeNull" [ro]', "not a string (null)"],
});
fixture("bad: an empty value", (s) => ((s.ro.probeEmpty = ""), (s.en.probeEmpty = "Empty")), {
  dictionary: ['key "probeEmpty" [ro]', "value is empty"],
});
fixture("bad: a whitespace-only value", (s) => ((s.ro.probeBlank = "Gol"), (s.en.probeBlank = " \n\t ")), {
  dictionary: ['key "probeBlank" [en]', "value is empty"],
});
fixture("bad: a placeholder in RO only", (s) => ((s.ro.probeCount = "Ai {count} activități"), (s.en.probeCount = "You have activities")), {
  dictionary: ['key "probeCount"', "RO {count}", "EN (none)"],
});
fixture("bad: different placeholder names", (s) => ((s.ro.probeCount = "Ai {count}"), (s.en.probeCount = "You have {total}")), {
  dictionary: ['key "probeCount"', "RO {count}", "EN {total}"],
});
fixture("good: the same placeholders in another order pass", (s) => ((s.ro.probeTwo = "{a} din {b} și {a}"), (s.en.probeTwo = "{b} of {a}")));

// Own keys only: "toString" is not "in" an object literal's own keys.
fixture("bad: key named like an Object.prototype member, in RO only", (s) => (s.ro.toString = "Doar RO"), {
  parity: ['key "toString" is in RO but missing from EN'],
});

// ------------------------------------------------------------------- runner

const lines = [];
let failed = 0;
let total = 0;
const report = (ok, title, detail = []) => {
  total++;
  if (!ok) failed++;
  lines.push(`${ok ? "ok  " : "FAIL"} ${title}`);
  for (const d of detail) lines.push(`     ${d}`);
};

// The real files.
let real;
try {
  real = runChecks(loadBundle(), { requiredScripts: REQUIRED_SCRIPTS });
} catch (error) {
  real = { results: [{ id: "sources", problems: [`could not read the client files: ${error.message || error}`] }], unused: [] };
}
for (const { id, problems } of real.results) report(problems.length === 0, CHECKS[id], problems);
lines.push(
  real.unused.length
    ? `info unused keys (${real.unused.length}, not a failure): ${real.unused.join(", ")}`
    : "info unused keys: none"
);

// The fixtures.
for (const fx of fixtures) {
  const { results, unused } = runChecks(fx.bundle, fx.options);
  const errors = [];
  const failing = results.filter((r) => r.problems.length).map((r) => r.id).sort();
  const wanted = Object.keys(fx.fails).sort();
  if (failing.join() !== wanted.join()) {
    errors.push(`failing checks: expected [${wanted.join(", ")}], got [${failing.join(", ")}]`);
    for (const r of results) for (const p of r.problems) errors.push(`  (${r.id}) ${p}`);
  }
  for (const id of wanted) {
    const text = (results.find((r) => r.id === id) || { problems: [] }).problems.join("\n");
    for (const needle of fx.fails[id]) {
      if (needle && !text.includes(needle)) errors.push(`check "${id}" output is missing "${needle}"`);
    }
  }
  for (const [id, needles] of Object.entries(fx.excludes || {})) {
    const text = (results.find((r) => r.id === id) || { problems: [] }).problems.join("\n");
    for (const needle of needles) if (text.includes(needle)) errors.push(`check "${id}" output must not contain "${needle}"`);
  }
  if (fx.unused && fx.unused.join() !== unused.join()) errors.push(`unused keys: expected [${fx.unused.join(", ")}], got [${unused.join(", ")}]`);
  report(errors.length === 0, `fixture ${fx.name}`, errors);
}

// The loader: query strings, unquoted src values, data-src, remote URLs and
// i18n.js itself, driven against a tiny temp directory.
{
  const errors = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "check-i18n-"));
  try {
    const files = {
      [HTML_FILE]: [
        "<!-- <script src=commented.js></script> -->",
        '<script src="draw.js?v=2"></script>',
        "<script src=app.js></script>",
        '<script src="./ui.js#top"></script>',
        `<script src="${I18N_FILE}?v=2"></script>`,
        '<script data-src="nope.js"></script>',
        '<script src="https://example.com/remote.js"></script>',
        '<script src="//example.com/remote2.js"></script>',
        '<script src="/monetize.js?a=1&b=2"></script>',
        '<script src="app.js"></script>',
        "<script>const inline = 1;</script>",
      ].join("\n"),
      [I18N_FILE]: "// i18n",
      "draw.js": "// draw",
      "app.js": "// app",
      "ui.js": "// ui",
      "monetize.js": "// monetize",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    const bundle = loadBundle(dir);
    const got = Object.keys(bundle.scripts);
    const want = ["draw.js", "app.js", "ui.js", "monetize.js"];
    if (got.join() !== want.join()) errors.push(`scripts found: expected [${want.join(", ")}], got [${got.join(", ")}]`);
    if (bundle.i18n !== "// i18n") errors.push(`${I18N_FILE} was not read for the dictionary`);
    if (bundle.scripts["draw.js"] !== "// draw") errors.push("draw.js?v=2 did not load draw.js");
  } catch (error) {
    errors.push(`loadBundle threw: ${error.message || error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  report(errors.length === 0, "loader finds scripts with ?v=2, #hash, unquoted src; skips data-src, remote URLs, comments and i18n.js", errors);
}

// Every stem has a sample that proves it, and every sample names a real stem.
function stemCoverageProblems(stems, samples) {
  const problems = [];
  for (const stem of stems) {
    if (!samples.some(([, , name]) => name === stem.name)) problems.push(`stem "${stem.name}" has no entry in STEM_SAMPLES`);
  }
  for (const [, text, name] of samples) {
    if (!stems.some((stem) => stem.name === name)) problems.push(`STEM_SAMPLES entry "${text}" names unknown stem "${name}"`);
    else if (!findStems(text).some((hit) => hit.stem.name === name)) problems.push(`STEM_SAMPLES entry "${text}" does not trigger stem "${name}"`);
  }
  return problems;
}
report(stemCoverageProblems(STEMS, STEM_SAMPLES).length === 0, "every stem has at least one sample that triggers it", stemCoverageProblems(STEMS, STEM_SAMPLES));
{
  const errors = [];
  const extra = [...STEMS, { name: "brand new", lang: "en", re: /\bbrandnew/ }];
  if (!stemCoverageProblems(extra, STEM_SAMPLES).some((p) => p.includes('"brand new" has no entry'))) errors.push("a stem without a sample was not reported");
  if (!stemCoverageProblems(STEMS, [...STEM_SAMPLES, ["en", "Hello", "buy"]]).some((p) => p.includes("does not trigger"))) errors.push("a sample that triggers nothing was not reported");
  report(errors.length === 0, "fixture bad: a stem without a sample, and a sample that triggers nothing, are reported", errors);
}

console.log(lines.join("\n"));
console.log(failed ? `\n${failed} of ${total} checks failed` : `\nall ${total} checks passed`);
process.exitCode = failed ? 1 : 0;
