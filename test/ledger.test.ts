import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  recordResults,
  readEntries,
  appendEntries,
  toEntry,
  truncateOutput,
  combinedOutput,
  ledgerPath,
  ensureVeritasDir,
  currentCommit,
  type LedgerEntry,
} from "../src/ledger.ts";
import type { CheckResult } from "../src/runner.ts";

const created: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "veritas-ledger-"));
  created.push(root);
  return root;
}

process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const result = (overrides: Partial<CheckResult> = {}): CheckResult => ({
  name: "test",
  command: "npm test",
  status: "failed",
  exitCode: 1,
  durationMs: 1234,
  stdout: "some output",
  stderr: "",
  blocking: true,
  timeoutSeconds: 300,
  ...overrides,
});

test("truncateOutput keeps the tail and says how much it dropped", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const truncated = truncateOutput(text, 50);

  assert.match(truncated, /150 earlier lines omitted/);
  assert.match(truncated, /line 199/);
  assert.doesNotMatch(truncated, /line 149\b/);
});

test("truncateOutput leaves short output untouched", () => {
  assert.equal(truncateOutput("a\nb\nc", 50), "a\nb\nc");
  assert.equal(truncateOutput("", 50), "");
  assert.equal(truncateOutput("   \n\n", 50), "");
});

test("truncateOutput enforces a hard character cap", () => {
  const truncated = truncateOutput("x".repeat(50_000), 50, 1000);
  assert.ok(truncated.length < 1100, `got ${truncated.length}`);
  assert.match(truncated, /output truncated/);
});

test("combinedOutput joins both streams when both are present", () => {
  assert.equal(combinedOutput(result({ stdout: "out", stderr: "err" })), "out\nerr");
  assert.equal(combinedOutput(result({ stdout: "out", stderr: "" })), "out");
  assert.equal(combinedOutput(result({ stdout: "", stderr: "err" })), "err");
  assert.equal(combinedOutput(result({ stdout: "", stderr: "" })), "");
});

test("an entry carries every documented field", () => {
  const entry = toEntry(result(), "hook", "abc1234");

  assert.equal(entry.trigger, "hook");
  assert.equal(entry.check, "test");
  assert.equal(entry.command, "npm test");
  assert.equal(entry.status, "failed");
  assert.equal(entry.exit_code, 1);
  assert.equal(entry.duration_ms, 1234);
  assert.equal(entry.blocking, true);
  assert.equal(entry.output, "some output");
  assert.equal(entry.git_commit, "abc1234");
  assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test("the ledger is append-only across calls", () => {
  const root = makeRoot();

  assert.equal(recordResults(root, [result({ name: "first" })], "manual"), true);
  assert.equal(recordResults(root, [result({ name: "second" })], "hook"), true);

  const entries = readEntries(root);
  assert.deepEqual(
    entries.map((entry) => entry.check),
    ["first", "second"],
  );

  const raw = readFileSync(ledgerPath(root), "utf8").trim().split("\n");
  assert.equal(raw.length, 2, "each run appends exactly one line per check");
});

test("the ledger directory ignores itself so it is never committed", () => {
  const root = makeRoot();
  ensureVeritasDir(root);

  const gitignore = join(root, ".veritas", ".gitignore");
  assert.ok(existsSync(gitignore));
  assert.match(readFileSync(gitignore, "utf8"), /^\*$/m);
});

test("ensureVeritasDir does not clobber an existing .gitignore", () => {
  const root = makeRoot();
  ensureVeritasDir(root);
  writeFileSync(join(root, ".veritas", ".gitignore"), "custom\n", "utf8");
  ensureVeritasDir(root);

  assert.equal(readFileSync(join(root, ".veritas", ".gitignore"), "utf8"), "custom\n");
});

test("reading a missing ledger yields no entries instead of throwing", () => {
  assert.deepEqual(readEntries(makeRoot()), []);
});

test("a damaged line is skipped rather than failing the whole read", () => {
  const root = makeRoot();
  recordResults(root, [result({ name: "good" })], "manual");
  appendFileSync(ledgerPath(root), "{ this is not json\n", "utf8");
  recordResults(root, [result({ name: "also-good" })], "manual");

  assert.deepEqual(
    readEntries(root).map((entry) => entry.check),
    ["good", "also-good"],
  );
});

test("readEntries returns the newest entries when a limit is given", () => {
  const root = makeRoot();
  for (let i = 0; i < 10; i += 1) {
    recordResults(root, [result({ name: `run-${i}` })], "manual");
  }

  assert.deepEqual(
    readEntries(root, 3).map((entry) => entry.check),
    ["run-7", "run-8", "run-9"],
  );
});

test("appendEntries with nothing to write is a no-op success", () => {
  const root = makeRoot();
  assert.equal(appendEntries(root, []), true);
  assert.equal(existsSync(ledgerPath(root)), false);
});

test("a failed ledger write reports false instead of throwing", () => {
  // A path whose parent is a file cannot be created as a directory.
  const root = makeRoot();
  const blocked = join(root, "blocked");
  writeFileSync(blocked, "not a directory", "utf8");

  const entry: LedgerEntry = toEntry(result(), "manual", null);
  assert.equal(appendEntries(join(blocked, "nested"), [entry]), false);
});

test("currentCommit returns null outside a git repository", () => {
  assert.equal(currentCommit(makeRoot()), null);
});
