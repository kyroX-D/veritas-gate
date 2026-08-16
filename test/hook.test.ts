// The Stop-hook decision tree, driven purely by JSON fixtures.
// No running Claude Code instance is involved anywhere in this file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleHook, type HookOutput } from "../src/hook.ts";
import { readEntries } from "../src/ledger.ts";
import { readState, blocksFor, statePath } from "../src/state.ts";
import { ensureVeritasDir } from "../src/ledger.ts";

const created: string[] = [];

function makeRoot(config?: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "veritas-hook-"));
  created.push(root);

  if (config !== undefined) {
    writeFileSync(join(root, ".veritas.yml"), config, "utf8");
  }

  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  return root;
}

process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const PASSING = 'node -e "process.exit(0)"';
const FAILING = 'node -e "console.error(\'AssertionError: expected 3 to equal 4\'); process.exit(1)"';

function config(command: string, extra = ""): string {
  return `version: 1
checks:
  - name: test
    run: ${command}
    timeout: 30
    blocking: true
max_attempts: 3
${extra}`;
}

function payload(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: root,
    hook_event_name: "Stop",
    last_assistant_message: "All done, the tests pass.",
    loop_protection_blocked: false,
    ...overrides,
  });
}

/**
 * A realistic environment: the real one, minus any VERITAS_SKIP the developer
 * happens to have set. Passing a bare `{}` would strip PATH, which makes every
 * check look like a missing tool rather than a failure.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["VERITAS_SKIP"];
  return env;
}

const call = (
  raw: string,
  root: string,
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = baseEnv(),
): Promise<HookOutput> => handleHook(raw, { argv, env, fallbackCwd: root });

const decisionOf = (output: HookOutput): string => output.hookSpecificOutput.decision;

// --- the two core behaviours ----------------------------------------------

test("a red blocking check blocks the turn", async () => {
  const root = makeRoot(config(FAILING));
  const output = await call(payload(root), root);

  assert.equal(decisionOf(output), "block");
  assert.equal(output.decision, "block", "the legacy top-level shape is emitted too");
  assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
});

test("a green blocking check lets the turn through", async () => {
  const root = makeRoot(config(PASSING));
  assert.equal(decisionOf(await call(payload(root), root)), "allow");
});

test("the block reason carries the check name, exit code and real output", async () => {
  const root = makeRoot(config(FAILING));
  const reason = (await call(payload(root), root)).hookSpecificOutput.reason ?? "";

  assert.match(reason, /test/);
  assert.match(reason, /exit code 1/);
  assert.match(reason, /AssertionError: expected 3 to equal 4/, "the agent must see the real failure output");
});

test("the block reason forbids weakening the checks", async () => {
  const root = makeRoot(config(FAILING));
  const reason = (await call(payload(root), root)).hookSpecificOutput.reason ?? "";

  assert.match(reason, /NOT verified/i);
  assert.match(reason, /Do NOT weaken, skip, delete or rewrite the checks/);
  assert.match(reason, /fix the underlying cause/i);
});

test("the user-facing systemMessage names the bypass", async () => {
  const root = makeRoot(config(FAILING));
  assert.match((await call(payload(root), root)).systemMessage ?? "", /VERITAS_SKIP=1/);
});

// --- bypasses --------------------------------------------------------------

test("VERITAS_SKIP=1 lets everything through", async () => {
  const root = makeRoot(config(FAILING));
  assert.equal(decisionOf(await call(payload(root), root, [], { ...baseEnv(), VERITAS_SKIP: "1" })), "allow");
});

test("VERITAS_SKIP=0 and empty do not count as a skip", async () => {
  const root = makeRoot(config(FAILING));
  assert.equal(decisionOf(await call(payload(root), root, [], { ...baseEnv(), VERITAS_SKIP: "0" })), "block");
  assert.equal(decisionOf(await call(payload(root), root, [], { ...baseEnv(), VERITAS_SKIP: "" })), "block");
});

test("--skip lets everything through", async () => {
  const root = makeRoot(config(FAILING));
  assert.equal(decisionOf(await call(payload(root), root, ["--skip"])), "allow");
});

test("a skip records nothing in the ledger", async () => {
  const root = makeRoot(config(FAILING));
  await call(payload(root), root, ["--skip"]);
  assert.deepEqual(readEntries(root), []);
});

test("dry_run reports but never blocks", async () => {
  const root = makeRoot(config(FAILING, "dry_run: true\n"));
  const output = await call(payload(root), root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /would have blocked/);
  assert.equal(readEntries(root).length, 1, "a dry run is still recorded as evidence");
});

// --- pass-throughs ---------------------------------------------------------

test("no config and no detectable project lets the turn through", async () => {
  const root = makeRoot();
  assert.equal(decisionOf(await call(payload(root), root)), "allow");
});

test("an empty checks list lets the turn through", async () => {
  const root = makeRoot("version: 1\nchecks: []\n");
  assert.equal(decisionOf(await call(payload(root), root)), "allow");
});

test("only non-blocking checks configured means nothing to block on", async () => {
  const root = makeRoot(`version: 1
checks:
  - name: lint
    run: ${FAILING}
    blocking: false
`);

  assert.equal(decisionOf(await call(payload(root), root)), "allow");
});

// --- loop protection and escalation ---------------------------------------

test("loop_protection_blocked stops veritas from blocking again", async () => {
  const root = makeRoot(config(FAILING));
  const output = await call(payload(root, { loop_protection_blocked: true }), root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /NOT VERIFIED/);
  assert.match(output.systemMessage ?? "", /loop protection/i);
});

test("the legacy stop_hook_active flag is honoured too", async () => {
  const root = makeRoot(config(FAILING));
  const output = await call(payload(root, { stop_hook_active: true, loop_protection_blocked: undefined }), root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /NOT VERIFIED/);
});

test("veritas escalates visibly after max_attempts instead of giving up silently", async () => {
  const root = makeRoot(config(FAILING));

  // max_attempts is 3: three blocks, then a visible NOT VERIFIED pass-through.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const output = await call(payload(root), root);
    assert.equal(decisionOf(output), "block", `attempt ${attempt} should still block`);
    assert.match(output.systemMessage ?? "", new RegExp(`attempt ${attempt}/3`));
  }

  const final = await call(payload(root), root);
  assert.equal(decisionOf(final), "allow", "the fourth turn must not block");

  const message = final.systemMessage ?? "";
  assert.match(message, /NOT VERIFIED/);
  assert.match(message, /GIVING UP/);
  assert.match(message, /max_attempts/);
  assert.ok(message.trim() !== "", "giving up silently is forbidden");
});

test("once veritas has given up it stays given up until the checks pass", async () => {
  const root = makeRoot(config(FAILING));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    assert.equal(decisionOf(await call(payload(root), root)), "block");
  }

  // Every subsequent turn must keep letting through rather than restarting the
  // block cycle, which would nag the user forever in a four-turn loop.
  for (let turn = 0; turn < 3; turn += 1) {
    const output = await call(payload(root), root);
    assert.equal(decisionOf(output), "allow", `turn ${turn + 1} after giving up must not block again`);
    assert.match(output.systemMessage ?? "", /NOT VERIFIED/);
  }
});

test("after giving up, going green resets veritas so it can gate again", async () => {
  const root = makeRoot(config(FAILING));

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await call(payload(root), root);
  }
  assert.equal(decisionOf(await call(payload(root), root)), "allow");

  // Fix the checks: veritas reports success and the counter resets.
  writeFileSync(join(root, ".veritas.yml"), config(PASSING), "utf8");
  const green = await call(payload(root), root);
  assert.equal(decisionOf(green), "allow");
  assert.equal(blocksFor(readState(root), "session-1"), 0);

  // Break them again: veritas must be willing to block once more.
  writeFileSync(join(root, ".veritas.yml"), config(FAILING), "utf8");
  assert.equal(decisionOf(await call(payload(root), root)), "block");
});

test("the attempt counter is per session", async () => {
  const root = makeRoot(config(FAILING));

  await call(payload(root, { session_id: "a" }), root);
  await call(payload(root, { session_id: "a" }), root);
  await call(payload(root, { session_id: "b" }), root);

  const state = readState(root);
  assert.equal(blocksFor(state, "a"), 2);
  assert.equal(blocksFor(state, "b"), 1);
});

test("a green run resets the counter", async () => {
  const root = makeRoot(config(FAILING));
  await call(payload(root), root);
  assert.equal(blocksFor(readState(root), "session-1"), 1);

  writeFileSync(join(root, ".veritas.yml"), config(PASSING), "utf8");
  await call(payload(root), root);

  assert.equal(blocksFor(readState(root), "session-1"), 0);
});

test("escalation still reports success if the checks have since gone green", async () => {
  const root = makeRoot(config(PASSING));
  const output = await call(payload(root, { loop_protection_blocked: true }), root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /all blocking checks passed/);
});

// --- the change cache ------------------------------------------------------

test("an unchanged tree skips the checks after a green run", async () => {
  const root = makeRoot(
    `${config(PASSING)}watch:\n  - "src/**"\n`,
    { "src/a.ts": "export const a = 1;" },
  );

  await call(payload(root), root);
  const afterFirst = readEntries(root).length;
  assert.ok(afterFirst > 0, "the first run must actually execute the checks");

  await call(payload(root), root);
  assert.equal(readEntries(root).length, afterFirst, "the second run must be served from the cache");
});

test("a changed watched file re-runs the checks", async () => {
  const root = makeRoot(
    `${config(PASSING)}watch:\n  - "src/**"\n`,
    { "src/a.ts": "export const a = 1;" },
  );

  await call(payload(root), root);
  const afterFirst = readEntries(root).length;

  writeFileSync(join(root, "src", "a.ts"), "export const a = 999999;", "utf8");
  await call(payload(root), root);

  assert.ok(readEntries(root).length > afterFirst, "a real change must invalidate the cache");
});

test("the cache never suppresses a failing check", async () => {
  const root = makeRoot(`${config(FAILING)}watch:\n  - "src/**"\n`, { "src/a.ts": "a" });

  assert.equal(decisionOf(await call(payload(root), root)), "block");
  assert.equal(decisionOf(await call(payload(root), root)), "block", "a red state must never be cached as green");
});

// --- the ledger ------------------------------------------------------------

test("hook runs are recorded with the hook trigger", async () => {
  const root = makeRoot(config(FAILING));
  await call(payload(root), root);

  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.trigger, "hook");
  assert.equal(entries[0]?.check, "test");
  assert.equal(entries[0]?.status, "failed");
  assert.equal(entries[0]?.exit_code, 1);
  assert.match(entries[0]?.output ?? "", /AssertionError/);
});

// --- fail-open -------------------------------------------------------------

test("a malformed payload lets the turn through with a warning", async () => {
  const root = makeRoot(config(FAILING));
  const output = await call("{ not json at all", root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /could not parse/);
});

test("an empty payload lets the turn through", async () => {
  const root = makeRoot();
  assert.equal(decisionOf(await call("", root)), "allow");
});

test("a payload with no cwd falls back to the given root", async () => {
  const root = makeRoot(config(FAILING));
  const output = await call(JSON.stringify({ session_id: "x", hook_event_name: "Stop" }), root);

  assert.equal(decisionOf(output), "block", "the fallback root must still be checked");
});

test("an unreadable config warns and lets the turn through", async () => {
  const root = makeRoot("checks:\n\t- broken\n");
  const output = await call(payload(root), root);

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /could not parse/);
});

test("a check whose command does not exist never blocks", async () => {
  const root = makeRoot(config("veritas-definitely-not-a-real-command-xyz"));
  const output = await call(payload(root), root);

  assert.equal(decisionOf(output), "allow", "a missing tool is veritas' problem, not the agent's");
});

test("a crashing runner does not block the session", async () => {
  // veritas breaking internally must cost the user nothing. The runner is
  // replaced by one that throws, which is what a genuine crash looks like from
  // the hook's point of view.
  const root = makeRoot(config(FAILING));

  const output = await handleHook(payload(root), {
    argv: [],
    env: baseEnv(),
    fallbackCwd: root,
    runner: () => {
      throw new Error("simulated runner crash");
    },
  });

  assert.equal(decisionOf(output), "allow", "a veritas crash must never block a turn");
  assert.match(output.systemMessage ?? "", /veritas-gate failed/);
  assert.match(output.systemMessage ?? "", /simulated runner crash/);
});

test("a runner that rejects asynchronously also fails open", async () => {
  const root = makeRoot(config(FAILING));

  const output = await handleHook(payload(root), {
    argv: [],
    env: baseEnv(),
    fallbackCwd: root,
    runner: async () => {
      await Promise.resolve();
      throw new Error("async runner explosion");
    },
  });

  assert.equal(decisionOf(output), "allow");
  assert.match(output.systemMessage ?? "", /async runner explosion/);
});

test("a crash leaves no block recorded against the session", async () => {
  const root = makeRoot(config(FAILING));

  await handleHook(payload(root), {
    argv: [],
    env: baseEnv(),
    fallbackCwd: root,
    runner: () => {
      throw new Error("boom");
    },
  });

  assert.equal(blocksFor(readState(root), "session-1"), 0);
});

test("a cwd below the project root still finds the project's config", async () => {
  const root = makeRoot(config(FAILING));
  const subdirectory = join(root, "src", "deep");
  mkdirSync(subdirectory, { recursive: true });

  // Claude Code's cwd is wherever the session sits. veritas walks up to the
  // config rather than looking only where it was invoked.
  const output = await call(payload(root, { cwd: subdirectory }), root);
  assert.equal(decisionOf(output), "block");

  assert.equal(readEntries(root).length, 1, "the ledger belongs at the project root, not the subdirectory");
});

test("a cwd that does not exist and has no project above it does not block", async () => {
  // A bare temp directory with no config and no .git anywhere above it.
  const nowhere = join(mkdtempSync(join(tmpdir(), "veritas-nowhere-")), "does", "not", "exist");

  const output = await handleHook(payload(nowhere, { cwd: nowhere }), {
    argv: [],
    env: baseEnv(),
    fallbackCwd: nowhere,
  });

  assert.equal(decisionOf(output), "allow");
});

test("an unwritable state directory does not block", async () => {
  const root = makeRoot(config(FAILING));
  ensureVeritasDir(root);

  // Make state.json a directory so writing it must fail.
  mkdirSync(statePath(root), { recursive: true });

  const output = await call(payload(root), root);
  assert.equal(decisionOf(output), "block", "the check itself still failed, so blocking is correct");

  // And with a passing check the failed state write must not turn into a block.
  writeFileSync(join(root, ".veritas.yml"), config(PASSING), "utf8");
  assert.equal(decisionOf(await call(payload(root), root)), "allow");

  chmodSync(root, 0o700);
});
