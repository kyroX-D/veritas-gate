import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readState,
  writeState,
  blocksFor,
  withBlock,
  withReset,
  globToRegExp,
  matchesAny,
  fingerprint,
  statePath,
  EMPTY_STATE,
} from "../src/state.ts";
import { ensureVeritasDir } from "../src/ledger.ts";

const created: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "veritas-state-"));
  created.push(root);
  return root;
}

process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

// --- globs -----------------------------------------------------------------

test("* stays within one path segment", () => {
  const regex = globToRegExp("*.json");
  assert.equal(regex.test("package.json"), true);
  assert.equal(regex.test("src/package.json"), false);
});

test("** spans path segments", () => {
  assert.equal(globToRegExp("src/**").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/**").test("src/deep/nested/a.ts"), true);
  assert.equal(globToRegExp("src/**").test("test/a.ts"), false);
});

test("**/ matches zero or more leading segments", () => {
  const regex = globToRegExp("**/*.py");
  assert.equal(regex.test("main.py"), true);
  assert.equal(regex.test("pkg/main.py"), true);
  assert.equal(regex.test("a/b/c/main.py"), true);
  assert.equal(regex.test("main.pyc"), false);
});

test("? matches one character within a segment", () => {
  assert.equal(globToRegExp("a?.ts").test("ab.ts"), true);
  assert.equal(globToRegExp("a?.ts").test("abc.ts"), false);
});

test("dots are literal, not wildcards", () => {
  assert.equal(globToRegExp("a.ts").test("axts"), false);
});

test("matchesAny normalises Windows separators", () => {
  assert.equal(matchesAny("src\\deep\\a.ts", ["src/**"]), true);
});

// --- state file ------------------------------------------------------------

test("reading missing state yields empty state", () => {
  assert.deepEqual(readState(makeRoot()), EMPTY_STATE);
});

test("state round-trips through disk", () => {
  const root = makeRoot();
  const next = withBlock(EMPTY_STATE, "session-a");

  assert.equal(writeState(root, next), true);
  assert.equal(blocksFor(readState(root), "session-a"), 1);
});

test("blocks accumulate per session and are independent", () => {
  let state = EMPTY_STATE;
  state = withBlock(state, "a");
  state = withBlock(state, "a");
  state = withBlock(state, "b");

  assert.equal(blocksFor(state, "a"), 2);
  assert.equal(blocksFor(state, "b"), 1);
  assert.equal(blocksFor(state, "unknown"), 0);
});

test("a reset clears the counter and stores the fingerprint", () => {
  const state = withReset(withBlock(EMPTY_STATE, "a"), "a", "abc123");

  assert.equal(blocksFor(state, "a"), 0);
  assert.equal(state.lastGreenFingerprint, "abc123");
  assert.notEqual(state.lastGreenAt, null);
});

test("a reset with a null fingerprint keeps the previous green timestamp", () => {
  const green = withReset(EMPTY_STATE, "a", "abc");
  const after = withReset(green, "a", null);

  assert.equal(after.lastGreenFingerprint, null);
  assert.equal(after.lastGreenAt, green.lastGreenAt);
});

test("corrupt state is replaced by empty state instead of throwing", () => {
  const root = makeRoot();
  ensureVeritasDir(root);
  writeFileSync(statePath(root), "{ not json", "utf8");

  assert.deepEqual(readState(root), EMPTY_STATE);
});

test("state with the wrong shape degrades gracefully", () => {
  const root = makeRoot();
  ensureVeritasDir(root);
  writeFileSync(statePath(root), JSON.stringify({ sessions: "nope", lastGreenFingerprint: 42 }), "utf8");

  const state = readState(root);
  assert.equal(state.lastGreenFingerprint, null);
  assert.equal(blocksFor(state, "a"), 0);
});

test("stale sessions are pruned on write", () => {
  const root = makeRoot();
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  writeState(root, {
    version: 1,
    sessions: { fresh: { blocks: 1, updated: new Date().toISOString() }, ancient: { blocks: 9, updated: old } },
    lastGreenFingerprint: null,
    lastGreenAt: null,
  });

  const state = readState(root);
  assert.equal(blocksFor(state, "fresh"), 1);
  assert.equal(blocksFor(state, "ancient"), 0);
});

// --- fingerprint -----------------------------------------------------------

test("no patterns means no fingerprint, so checks always run", () => {
  assert.equal(fingerprint(makeRoot(), []), null);
});

test("patterns matching nothing yield null rather than a constant hash", () => {
  const root = makeRoot();
  write(root, "readme.md", "hi");
  assert.equal(fingerprint(root, ["src/**"]), null);
});

test("the same tree fingerprints identically", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "export const a = 1;");
  write(root, "src/b.ts", "export const b = 2;");

  assert.equal(fingerprint(root, ["src/**"]), fingerprint(root, ["src/**"]));
});

test("changing a watched file changes the fingerprint", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "export const a = 1;");
  const before = fingerprint(root, ["src/**"]);

  write(root, "src/a.ts", "export const a = 2222222;");
  assert.notEqual(fingerprint(root, ["src/**"]), before);
});

test("adding a watched file changes the fingerprint", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "a");
  const before = fingerprint(root, ["src/**"]);

  write(root, "src/b.ts", "b");
  assert.notEqual(fingerprint(root, ["src/**"]), before);
});

test("touching an unwatched file does not change the fingerprint", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "a");
  const before = fingerprint(root, ["src/**"]);

  write(root, "docs/readme.md", "unrelated");
  assert.equal(fingerprint(root, ["src/**"]), before);
});

test("a touched mtime changes the fingerprint", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "a");
  const before = fingerprint(root, ["src/**"]);

  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, "src/a.ts"), future, future);

  assert.notEqual(fingerprint(root, ["src/**"]), before);
});

test("ignored directories are not walked", () => {
  const root = makeRoot();
  write(root, "src/a.ts", "a");
  const before = fingerprint(root, ["**/*.ts"]);

  write(root, "node_modules/pkg/index.ts", "noise");
  write(root, ".git/objects/whatever.ts", "noise");

  assert.equal(fingerprint(root, ["**/*.ts"]), before);
});
