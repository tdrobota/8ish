// Proves that only client files are published. Requests a fixed list of
// server-side paths (each must answer 404) and the app's entry paths (each
// must answer 200) on a running site, and exits non-zero on any other answer.
// Redirects are not followed: a 3xx, or a 200 fallback page for a forbidden
// path, is a failure and the path is named. The one allowance is /index.html
// answering with a redirect to / (Cloudflare's default), see REDIRECTS below.
// No dependencies, Node 18+.
//
//   node scripts/check-public.mjs http://localhost:8787
//   node scripts/check-public.mjs https://8ish.app
//   node scripts/check-public.mjs --self-test
//
// Exits 0 when every path answers as required, 1 otherwise (2 on bad usage).
// --self-test starts a good and several bad servers in this process and proves
// the check passes the good one and fails each bad one. Run by hand until
// Epic 4.4 wires it into the pipeline against the production domain.

import http from "node:http";

// Answered by the static assets layer (from public/): must be 200.
const MUST_BE_200 = ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/icons/icon-192.png"];

// Server code, docs, stats, config and repo files: must be 404. New paths
// (a future config/ file, governor.js, another docs/ file, and so on) get
// added here as they appear.
const MUST_BE_404 = [
  "/worker.js",
  "/governor.js",
  "/functions/api/transform.js",
  "/docs/business-analysis.md",
  "/docs/business-analysis-addendum-one-time.md",
  "/docs/runbook.md",
  "/stats/Total.csv",
  "/wrangler.jsonc",
  "/README.md",
  "/package.json",
  "/config/governor.json",
  "/scripts/check-i18n.mjs",
  "/scripts/check-sw.mjs",
  "/scripts/check-config.mjs",
  "/scripts/check-public.mjs",
];

const TIMEOUT_MS = 10000;

async function statusOf(baseUrl, pathname) {
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.arrayBuffer(); // release the connection
    return { status: response.status, location: response.headers.get("location") };
  } catch (error) {
    return { error: String((error.cause && error.cause.code) || error.message || error) };
  }
}

// Cloudflare's default html_handling ("auto-trailing-slash") answers
// /index.html with a redirect to /. That is the app being served, so
// /index.html alone may answer with a redirect, and only to another required
// path that itself answers 200. / and /sw.js get no such allowance: a browser
// and a service worker registration both need those two to answer 200
// directly, with no redirect hop, so they are held to a plain 200. Forbidden
// paths get no allowance either: only 404 passes.
const REDIRECTS = [301, 302, 303, 307, 308];
const REDIRECT_ALLOWED_FROM = "/index.html";

async function redirectsToApp(baseUrl, from, got) {
  if (from !== REDIRECT_ALLOWED_FROM) return null;
  if (!REDIRECTS.includes(got.status) || !got.location) return null;
  let target;
  try {
    target = new URL(got.location, new URL(from, baseUrl));
  } catch {
    return null;
  }
  if (target.origin !== new URL(baseUrl).origin || target.pathname === from || !MUST_BE_200.includes(target.pathname) || target.search) return null;
  const landed = await statusOf(baseUrl, target.pathname);
  return landed.status === 200 ? target.pathname : null;
}

// Returns { ok, lines } where lines has one "ok" or "FAIL" line per path.
async function checkPublic(baseUrl) {
  const wanted = [...MUST_BE_200.map((p) => [p, 200]), ...MUST_BE_404.map((p) => [p, 404])];
  const lines = [];
  let ok = true;
  for (const [pathname, expected] of wanted) {
    const got = await statusOf(baseUrl, pathname);
    let pass = got.status === expected;
    let shown = String(expected);
    if (!pass && expected === 200) {
      const landing = await redirectsToApp(baseUrl, pathname, got);
      if (landing) {
        pass = true;
        shown = `${got.status} -> ${landing} 200`;
      }
    }
    if (!pass) ok = false;
    const answer = got.error ? `request failed (${got.error})` : `got ${got.status}${got.location ? ` -> ${got.location}` : ""}`;
    lines.push(pass ? `ok   ${pathname} ${shown}` : `FAIL ${pathname} expected ${expected}, ${answer}`);
  }
  return { ok, lines };
}

// ---------------------------------------------------------------- self-test

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const send = (res, status, body = "", headers = {}) => {
  res.writeHead(status, { "content-type": "text/plain", ...headers });
  res.end(body);
};

// A site that behaves as required: app paths 200, everything else 404.
const good = (req, res) => (MUST_BE_200.includes(req.url) ? send(res, 200, "app") : send(res, 404, "Not found"));

// The production shape: /index.html redirects to / (Cloudflare's default).
const goodWithRedirect = (req, res) => (req.url === "/index.html" ? send(res, 307, "", { location: "/" }) : good(req, res));

const badServers = {
  "/index.html redirects to a forbidden path": (req, res) => (req.url === "/index.html" ? send(res, 307, "", { location: "/worker.js" }) : good(req, res)),
  "/index.html redirects to another origin": (req, res) => (req.url === "/index.html" ? send(res, 307, "", { location: "https://example.com/" }) : good(req, res)),
  "/index.html redirects to / but / is 404": (req, res) => (req.url === "/index.html" ? send(res, 307, "", { location: "/" }) : req.url === "/" ? send(res, 404) : good(req, res)),
  "/sw.js redirects to itself": (req, res) => (req.url === "/sw.js" ? send(res, 307, "", { location: "/sw.js" }) : good(req, res)),
  "/ redirects to /index.html (which is 200)": (req, res) => (req.url === "/" ? send(res, 307, "", { location: "/index.html" }) : good(req, res)),
  "/sw.js redirects to / (which is 200)": (req, res) => (req.url === "/sw.js" ? send(res, 307, "", { location: "/" }) : good(req, res)),
  "serves /worker.js": (req, res) => (req.url === "/worker.js" ? send(res, 200, "export default {}") : good(req, res)),
  "serves /docs/runbook.md": (req, res) => (req.url === "/docs/runbook.md" ? send(res, 200, "# runbook") : good(req, res)),
  "serves /wrangler.jsonc": (req, res) => (req.url === "/wrangler.jsonc" ? send(res, 200, "{}") : good(req, res)),
  "SPA fallback: 200 index page for every unknown path": (req, res) => send(res, 200, "<html>app</html>"),
  "redirects a forbidden path": (req, res) => (req.url === "/stats/Total.csv" ? send(res, 302, "", { location: "/" }) : good(req, res)),
  "404s /": (req, res) => (req.url === "/" ? send(res, 404, "Not found") : good(req, res)),
  "404s /sw.js": (req, res) => (req.url === "/sw.js" ? send(res, 404, "Not found") : good(req, res)),
  "answers 500 for a forbidden path": (req, res) => (req.url === "/README.md" ? send(res, 500, "boom") : good(req, res)),
};

async function selfTest() {
  const problems = [];

  const site = await listen(good);
  const goodRun = await checkPublic(site.url);
  site.server.close();
  console.log(`good server: ${goodRun.ok ? "accepted" : "REJECTED"}`);
  if (!goodRun.ok) problems.push(`good server was rejected:\n${goodRun.lines.filter((l) => l.startsWith("FAIL")).join("\n")}`);

  const shape = await listen(goodWithRedirect);
  const shapeRun = await checkPublic(shape.url);
  shape.server.close();
  console.log(`good server (/index.html redirects to /): ${shapeRun.ok ? "accepted" : "REJECTED"}`);
  if (!shapeRun.ok) problems.push(`redirecting good server was rejected:\n${shapeRun.lines.filter((l) => l.startsWith("FAIL")).join("\n")}`);

  for (const [name, handler] of Object.entries(badServers)) {
    const bad = await listen(handler);
    const run = await checkPublic(bad.url);
    bad.server.close();
    const fails = run.lines.filter((l) => l.startsWith("FAIL"));
    console.log(`bad server (${name}): ${run.ok ? "ACCEPTED" : `rejected, ${fails.length} path(s) named`}`);
    if (run.ok || fails.length === 0) problems.push(`bad server "${name}" was accepted`);
  }

  // Nothing listening: every path must fail.
  const dead = await listen(good);
  dead.server.close();
  const deadRun = await checkPublic(dead.url);
  console.log(`unreachable server: ${deadRun.ok ? "ACCEPTED" : "rejected"}`);
  if (deadRun.ok) problems.push("an unreachable server was accepted");

  if (problems.length) {
    console.log(`\nself-test FAILED\n${problems.join("\n")}`);
    return 1;
  }
  console.log("\nself-test passed");
  return 0;
}

// ------------------------------------------------------------------- runner

const arg = process.argv[2];
const usage = () => {
  console.error("usage: node scripts/check-public.mjs <baseUrl>   (for example http://localhost:8787)\n       node scripts/check-public.mjs --self-test");
  process.exitCode = 2;
};
if (arg === "--self-test") {
  if (process.argv.length > 3) {
    usage();
  } else {
    process.exitCode = await selfTest();
  }
} else if (!arg || process.argv.length > 3 || !/^https?:\/\//i.test(arg)) {
  usage();
} else {
  const { ok, lines } = await checkPublic(arg);
  console.log(lines.join("\n"));
  console.log(ok ? `\nall ${lines.length} paths answered as required` : `\n${lines.filter((l) => l.startsWith("FAIL")).length} of ${lines.length} paths failed`);
  process.exitCode = ok ? 0 : 1;
}
