// A reproducible demo of the gate, for recording or for trying it out.
//
//   node scripts/demo.mjs           run it
//   node scripts/demo.mjs --slow    add pauses, for screen recording
//
// It builds a throwaway project in a temp directory, drives the real bundled
// binary, and cleans up after itself. Nothing here is staged: every line of
// output below the prompts comes from the command that was actually run.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const veritas = join(root, "dist", "veritas.mjs");
const slow = process.argv.includes("--slow");

const sleep = (ms) => (slow ? Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) : undefined);

function say(text = "") {
  process.stdout.write(`${text}\n`);
}

function prompt(command) {
  sleep(600);
  say(`[90m$[0m ${command}`);
  sleep(400);
}

/** Runs a command and echoes its output, exactly as it came back. */
function run(args, cwd) {
  try {
    const out = execFileSync(process.execPath, [veritas, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, VERITAS_SKIP: undefined },
    });
    say(out.trimEnd());
    return 0;
  } catch (error) {
    say(String(error.stdout ?? "").trimEnd());
    if (error.stderr) say(String(error.stderr).trimEnd());
    return error.status ?? 1;
  }
}

/** Sends a Stop-hook payload and prints the decision the way Claude Code sees it. */
function hook(cwd, note) {
  const payload = JSON.stringify({
    session_id: "demo",
    cwd,
    hook_event_name: "Stop",
    last_assistant_message: note,
    loop_protection_blocked: false,
  });

  const out = execFileSync(process.execPath, [veritas, "hook"], {
    input: payload,
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, VERITAS_SKIP: undefined },
  });

  return JSON.parse(out);
}

/**
 * Trims the block reason to the part that carries the argument: the header,
 * the command, and the assertion itself. The agent receives the whole thing;
 * this shortening is only for the screen.
 */
function excerpt(reason) {
  const lines = reason.split(/\r?\n/).map((line) => line.trimEnd());
  const head = lines.slice(0, 7);
  const at = lines.findIndex((line) => line.includes("AssertionError"));

  if (at === -1) return [...head, "..."];
  return [...head, "...", ...lines.slice(at, at + 4)];
}

const BROKEN = `export function total(numbers) {
  let sum = 0;
  for (let i = 0; i < numbers.length - 1; i += 1) {
    sum += numbers[i];
  }
  return sum;
}
`;

const FIXED = BROKEN.replace("numbers.length - 1", "numbers.length");

const TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/total.js";

test("sums every number", () => {
  assert.equal(total([1, 2, 3]), 6);
});
`;

const project = mkdtempSync(join(tmpdir(), "veritas-demo-"));

try {
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "test"), { recursive: true });
  writeFileSync(join(project, "src", "total.js"), BROKEN);
  writeFileSync(join(project, "test", "total.test.js"), TEST);
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "demo", private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2)}\n`,
  );

  say();
  say("[1m  1. The agent says it is finished.[0m");
  say();
  say('     "Fixed the bug in total(). All tests pass."');
  say();
  sleep(1200);

  say("[1m  2. veritas-gate intercepts the end of the turn.[0m");
  say();

  const blocked = hook(project, "Fixed the bug in total(). All tests pass.");
  say(`     decision: [31m${blocked.hookSpecificOutput.decision}[0m`);
  say();
  for (const line of excerpt(blocked.hookSpecificOutput.reason ?? "")) {
    say(`     ${line}`);
  }
  say();
  sleep(1500);

  say("[1m  3. The agent gets the real assertion back, and fixes the cause.[0m");
  say();
  writeFileSync(join(project, "src", "total.js"), FIXED);
  say("     -  for (let i = 0; i < numbers.length - 1; i += 1) {");
  say("     +  for (let i = 0; i < numbers.length; i += 1) {");
  say();
  sleep(1200);

  say("[1m  4. Now the turn is allowed to end.[0m");
  say();
  const allowed = hook(project, "Fixed the off-by-one. Tests pass.");
  say(`     decision: [32m${allowed.hookSpecificOutput.decision}[0m`);
  say();
  sleep(1000);

  say("[1m  5. Both runs are in the ledger, either way.[0m");
  say();
  prompt("veritas status");
  run(["status"], project);
  say();
} finally {
  rmSync(project, { recursive: true, force: true });
}
