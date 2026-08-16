import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runCheck,
  runChecks,
  isBlockingFailure,
  isInfrastructureProblem,
  programName,
  programExists,
} from "../src/runner.ts";
import type { Check } from "../src/config.ts";

const root = mkdtempSync(join(tmpdir(), "veritas-run-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const check = (overrides: Partial<Check> & Pick<Check, "run">): Check => ({
  name: "check",
  timeout: 30,
  blocking: true,
  ...overrides,
});

test("a successful command is reported as passed", async () => {
  const result = await runCheck(check({ name: "ok", run: "node -e \"process.exit(0)\"" }), { cwd: root });

  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.name, "ok");
  assert.ok(result.durationMs >= 0);
  assert.equal(isBlockingFailure(result), false);
});

test("a failing command is reported with its exit code", async () => {
  const result = await runCheck(check({ name: "bad", run: "node -e \"process.exit(3)\"" }), { cwd: root });

  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 3);
  assert.equal(isBlockingFailure(result), true);
});

test("stdout is captured", async () => {
  const result = await runCheck(check({ run: 'node -e "console.log(\'hello from stdout\')"' }), { cwd: root });

  assert.equal(result.status, "passed");
  assert.match(result.stdout, /hello from stdout/);
});

test("stderr is captured on failure", async () => {
  const result = await runCheck(
    check({ run: 'node -e "console.error(\'boom on stderr\'); process.exit(1)"' }),
    { cwd: root },
  );

  assert.equal(result.status, "failed");
  assert.match(result.stderr, /boom on stderr/);
});

test("a command that exceeds its timeout is killed and reported as timed-out", async () => {
  const result = await runCheck(
    check({ name: "slow", run: 'node -e "setTimeout(() => {}, 60000)"', timeout: 1 }),
    { cwd: root },
  );

  assert.equal(result.status, "timed-out");
  assert.equal(isBlockingFailure(result), true);
  assert.ok(result.durationMs < 30_000, `expected a quick kill, took ${result.durationMs}ms`);
});

test("a missing command is unavailable, not a failure, and never blocks", async () => {
  const result = await runCheck(check({ name: "ghost", run: "veritas-definitely-not-a-real-command-xyz" }), {
    cwd: root,
  });

  assert.equal(result.status, "unavailable");
  assert.equal(isBlockingFailure(result), false, "a missing tool must never block a turn");
  assert.equal(isInfrastructureProblem(result), true);
});

test("programName extracts the program from a command line", () => {
  assert.equal(programName("npm test"), "npm");
  assert.equal(programName("  cargo   test --all  "), "cargo");
  assert.equal(programName('"C:/Program Files/x/y.exe" --flag'), "C:/Program Files/x/y.exe");
  assert.equal(programName("./scripts/check.sh"), "./scripts/check.sh");
  assert.equal(programName(""), undefined);
  // Not a plain "program args" form: refuse to guess.
  assert.equal(programName("FOO=1 npm test"), undefined);
  assert.equal(programName("a|b"), undefined);
});

test("programExists resolves a real program and rejects a fake one", () => {
  assert.equal(programExists("node -e \"0\""), true);
  assert.equal(programExists("veritas-definitely-not-a-real-command-xyz"), false);
});

test("programExists reports unknown forms as present rather than missing", () => {
  // Guessing wrong here would downgrade a real failure to "unavailable".
  assert.equal(programExists("FOO=1 some-command"), true);
  assert.equal(programExists("echo hello"), true, "shell builtins must not look missing");
});

test("a non-blocking failure does not count as a blocking failure", async () => {
  const result = await runCheck(check({ run: "node -e \"process.exit(1)\"", blocking: false }), { cwd: root });

  assert.equal(result.status, "failed");
  assert.equal(isBlockingFailure(result), false);
});

test("the check runs in the given working directory", async () => {
  const result = await runCheck(check({ run: 'node -e "console.log(process.cwd())"' }), { cwd: root });

  // realpath differences (/var vs /private/var) make an exact compare brittle.
  assert.ok(result.stdout.trim().length > 0);
  assert.match(result.stdout.trim().replaceAll("\\", "/").toLowerCase(), /veritas-run-/);
});

test("VERITAS_SKIP is set for child processes so nested runs cannot recurse", async () => {
  const result = await runCheck(check({ run: 'node -e "console.log(process.env.VERITAS_SKIP)"' }), { cwd: root });

  assert.equal(result.stdout.trim(), "1");
});

test("runChecks runs every check in order", async () => {
  const results = await runChecks(
    [
      check({ name: "one", run: "node -e \"process.exit(0)\"" }),
      check({ name: "two", run: "node -e \"process.exit(0)\"" }),
    ],
    { cwd: root },
  );

  assert.deepEqual(
    results.map((result) => result.name),
    ["one", "two"],
  );
});

test("runChecks can stop at the first blocking failure", async () => {
  const results = await runChecks(
    [
      check({ name: "one", run: "node -e \"process.exit(1)\"" }),
      check({ name: "two", run: "node -e \"process.exit(0)\"" }),
    ],
    { cwd: root, stopOnFirstBlockingFailure: true },
  );

  assert.deepEqual(
    results.map((result) => result.name),
    ["one"],
  );
});

test("runChecks does not stop early on a non-blocking failure", async () => {
  const results = await runChecks(
    [
      check({ name: "one", run: "node -e \"process.exit(1)\"", blocking: false }),
      check({ name: "two", run: "node -e \"process.exit(0)\"" }),
    ],
    { cwd: root, stopOnFirstBlockingFailure: true },
  );

  assert.equal(results.length, 2);
});

test("large output is captured without exhausting memory", async () => {
  const result = await runCheck(
    check({
      run: 'node -e "for (let i = 0; i < 20000; i++) console.log(\'line \' + i)"',
      timeout: 60,
    }),
    { cwd: root },
  );

  assert.equal(result.status, "passed");
  assert.ok(result.stdout.length <= 512 * 1024 + 65536, `captured ${result.stdout.length} bytes`);
  assert.match(result.stdout, /line 19999/, "the tail of the output must be kept");
});
