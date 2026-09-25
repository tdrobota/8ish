// Runs every scripts/check-*.mjs script in a fixed order and stops at the
// first failure. This is what `npm run check` (and the Workers Builds
// project's Build command, `npm ci && npm run check`) runs before a deploy.
//
//   node scripts/run-checks.mjs
//   node scripts/run-checks.mjs --self-test
//
// On success: one summary line per check, exits 0.
// On failure: that check's full stdout/stderr, then exits non-zero; checks
// after it do not run.
//
// check-public.mjs runs with --self-test here: there is no live URL before a
// deploy. Running it against the real production domain after a deploy is a
// separate, manual step (see README).
//
// ORDER below is a fixed allowlist, not auto-discovery: a check-*.mjs file
// that exists in scripts/ but isn't listed in ORDER fails the whole run
// (rather than being silently skipped, or silently run in whatever order the
// filesystem hands it back). A new check script must be added to ORDER
// before it is included.
//
// --self-test proves this script's own control flow (fixed order, stop on
// first failure, exit code) against two tiny throwaway fixture scripts, not
// the real checks -- following the same pattern as check-public.mjs's own
// --self-test. Run by hand; nothing in the pipeline currently calls it.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPTS_DIR = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const TIMEOUT_MS = 120000; // checks normally take well under a second
const MAX_BUFFER = 10 * 1024 * 1024; // Node's spawnSync default (1MB) is too small for a verbose failure

// Fixed order this story's four checks run in, and the argv each gets.
const ORDER = [
  { file: "check-sw.mjs", args: [] },
  { file: "check-config.mjs", args: [] },
  { file: "check-i18n.mjs", args: [] },
  { file: "check-shared.mjs", args: [] },
  { file: "check-public.mjs", args: ["--self-test"] },
];

// Confirms `scriptsDir` holds exactly the check-*.mjs files `order` expects:
// none missing, none extra/unrecognized. Returns an array of problem lines
// (empty when everything lines up); never throws.
function validateOrder(scriptsDir, order, selfPath) {
  let entries;
  try {
    entries = readdirSync(scriptsDir);
  } catch (error) {
    return [`could not read ${scriptsDir}: ${error.message}`];
  }

  const discovered = entries
    .filter((name) => /^check-.*\.mjs$/.test(name))
    .filter((name) => path.join(scriptsDir, name) !== selfPath)
    .sort();

  const known = new Set(order.map((c) => c.file));
  const unknown = discovered.filter((name) => !known.has(name));

  const discoveredSet = new Set(discovered);
  const missing = order.filter((c) => !discoveredSet.has(c.file));

  const problems = [];
  if (unknown.length) {
    problems.push(`found scripts/check-*.mjs not in the known order: ${unknown.join(", ")} -- add each to ORDER in scripts/run-checks.mjs (with the args it should run with) before running the checks.`);
  }
  if (missing.length) {
    problems.push(`expected scripts/check-*.mjs missing: ${missing.map((c) => c.file).join(", ")}`);
  }
  return problems;
}

// Runs `order` (an array of { file, args }) from `scriptsDir`, in order,
// stopping at the first failure. Returns { ok, log }: log is every line this
// run produced, in print order, so both the real run and --self-test can
// decide what to do with it without this function touching the console.
function runOrder(scriptsDir, order) {
  const log = [];
  for (const { file, args } of order) {
    const scriptPath = path.join(scriptsDir, file);
    const label = args.length ? `${file} ${args.join(" ")}` : file;
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });

    if (result.error) {
      log.push(`FAIL ${label}: failed to run (${result.error.message})`);
      return { ok: false, log };
    }

    if (result.status !== 0) {
      if (result.stdout) log.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) log.push(result.stderr.replace(/\n$/, ""));
      const how = result.status === null ? `killed by ${result.signal || "an unknown signal"}` : `exit ${result.status}`;
      log.push(`FAIL ${label} (${how})`);
      return { ok: false, log };
    }

    log.push(`ok   ${label}`);
  }
  log.push("\nall checks passed");
  return { ok: true, log };
}

// ---------------------------------------------------------------- self-test

// Writes a tiny fixture check-*.mjs that exits 0 or 1 immediately.
function writeFixture(dir, name, exitCode) {
  writeFileSync(path.join(dir, name), `console.log(${JSON.stringify(`fixture ${name}`)});\nprocess.exitCode = ${exitCode};\n`);
}

function selfTest() {
  const problems = [];
  const tmp = mkdtempSync(path.join(os.tmpdir(), "run-checks-selftest-"));

  try {
    // (a) every fixture passes: exits 0, every one reported, in order.
    writeFixture(tmp, "check-a.mjs", 0);
    writeFixture(tmp, "check-b.mjs", 0);
    writeFixture(tmp, "check-c.mjs", 0);
    const allPassOrder = [
      { file: "check-a.mjs", args: [] },
      { file: "check-b.mjs", args: [] },
      { file: "check-c.mjs", args: [] },
    ];
    const allPassRun = runOrder(tmp, allPassOrder);
    const allPassOk = allPassRun.ok && allPassOrder.every(({ file }) => allPassRun.log.includes(`ok   ${file}`));
    console.log(`all-passing fixtures: ${allPassOk ? "accepted, all three reported" : "REJECTED"}`);
    if (!allPassOk) problems.push(`all-passing fixtures did not behave as expected:\n${allPassRun.log.join("\n")}`);

    // (b) a failure in the middle stops there; the check after it never runs.
    writeFixture(tmp, "check-d-fails.mjs", 1);
    const midFailOrder = [
      { file: "check-a.mjs", args: [] },
      { file: "check-d-fails.mjs", args: [] },
      { file: "check-c.mjs", args: [] },
    ];
    const midFailRun = runOrder(tmp, midFailOrder);
    const stoppedRight =
      !midFailRun.ok &&
      midFailRun.log.includes("ok   check-a.mjs") &&
      midFailRun.log.some((line) => line.startsWith("FAIL check-d-fails.mjs")) &&
      !midFailRun.log.includes("ok   check-c.mjs");
    console.log(`failure in the middle: ${stoppedRight ? "stopped there, exit non-zero, later check did not run" : "WRONG BEHAVIOR"}`);
    if (!stoppedRight) problems.push(`mid-order failure did not stop the run correctly:\n${midFailRun.log.join("\n")}`);

    // (c) an unrecognized check-*.mjs and a missing one are both reported.
    writeFixture(tmp, "check-unlisted.mjs", 0);
    const partialOrder = [
      { file: "check-a.mjs", args: [] },
      { file: "check-missing.mjs", args: [] },
    ];
    const problemsFound = validateOrder(tmp, partialOrder, path.join(tmp, "run-checks.mjs"));
    const reportedBoth = problemsFound.some((p) => p.includes("check-unlisted.mjs") || p.includes("check-b.mjs") || p.includes("check-c.mjs") || p.includes("check-d-fails.mjs")) && problemsFound.some((p) => p.includes("check-missing.mjs"));
    console.log(`unrecognized + missing reported together: ${reportedBoth ? "both named" : "WRONG BEHAVIOR"}`);
    if (!reportedBoth) problems.push(`validateOrder did not report both problems:\n${problemsFound.join("\n")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

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
  console.error("usage: node scripts/run-checks.mjs\n       node scripts/run-checks.mjs --self-test");
  process.exitCode = 2;
};

if (arg === "--self-test") {
  if (process.argv.length > 3) {
    usage();
  } else {
    process.exitCode = selfTest();
  }
} else if (arg) {
  usage();
} else {
  const problems = validateOrder(SCRIPTS_DIR, ORDER, SELF);
  if (problems.length) {
    for (const line of problems) console.error(`run-checks: ${line}`);
    process.exitCode = 1;
  } else {
    const { ok, log } = runOrder(SCRIPTS_DIR, ORDER);
    console.log(log.join("\n"));
    process.exitCode = ok ? 0 : 1;
  }
}
