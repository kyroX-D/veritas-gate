import { test } from "node:test";
import assert from "node:assert/strict";

import { parseYaml, YamlError } from "../src/yaml.ts";

test("parses the documented .veritas.yml shape", () => {
  const source = `version: 1

checks:
  - name: typecheck
    run: npm run typecheck
    timeout: 120        # seconds
    blocking: true
  - name: test
    run: npm test
    timeout: 300
    blocking: true
  - name: lint
    run: npm run lint
    timeout: 60
    blocking: false     # reports, does not block

# How many consecutive blocks before giving up
max_attempts: 4

watch:
  - "src/**"
  - "test/**"

dry_run: false
`;

  assert.deepEqual(parseYaml(source), {
    version: 1,
    checks: [
      { name: "typecheck", run: "npm run typecheck", timeout: 120, blocking: true },
      { name: "test", run: "npm test", timeout: 300, blocking: true },
      { name: "lint", run: "npm run lint", timeout: 60, blocking: false },
    ],
    max_attempts: 4,
    watch: ["src/**", "test/**"],
    dry_run: false,
  });
});

test("empty and comment-only documents parse to null", () => {
  assert.equal(parseYaml(""), null);
  assert.equal(parseYaml("# nothing here\n\n   \n"), null);
});

test("scalar types are converted", () => {
  assert.deepEqual(parseYaml("a: 1\nb: -2\nc: 1.5\nd: true\ne: false\nf: null\ng: ~\nh: text"), {
    a: 1,
    b: -2,
    c: 1.5,
    d: true,
    e: false,
    f: null,
    g: null,
    h: "text",
  });
});

test("yes/no/on/off are booleans", () => {
  assert.deepEqual(parseYaml("a: yes\nb: no\nc: on\nd: off"), { a: true, b: false, c: true, d: false });
});

test("quotes are stripped and protect special characters", () => {
  assert.deepEqual(parseYaml(`a: "hash # not a comment"\nb: 'single'\nc: "123"`), {
    a: "hash # not a comment",
    b: "single",
    c: "123",
  });
});

test("a colon inside a command value is preserved", () => {
  assert.deepEqual(parseYaml("run: npm run test:unit -- --reporter dot"), {
    run: "npm run test:unit -- --reporter dot",
  });
});

test("a trailing comment is stripped but an inline hash is not", () => {
  assert.deepEqual(parseYaml("a: value   # trailing\nb: no-comment#here"), {
    a: "value",
    b: "no-comment#here",
  });
});

test("an apostrophe inside a plain scalar does not swallow the comment", () => {
  // Regression: treating every quote as a delimiter left the comment in the
  // command, so veritas ran `echo it's fine   # note`.
  assert.deepEqual(parseYaml("run: echo it's fine   # note"), { run: "echo it's fine" });
  assert.deepEqual(parseYaml('run: node -e "x"   # note'), { run: 'node -e "x"' });
});

test("a sequence may sit at the same indentation as its key", () => {
  assert.deepEqual(parseYaml("watch:\n- src/**\n- test/**\n"), { watch: ["src/**", "test/**"] });
});

test("nested mappings are supported", () => {
  assert.deepEqual(parseYaml("outer:\n  inner:\n    leaf: 3\n"), { outer: { inner: { leaf: 3 } } });
});

test("a key with no value is null", () => {
  assert.deepEqual(parseYaml("checks:\nversion: 1"), { checks: null, version: 1 });
});

test("a top-level sequence parses", () => {
  assert.deepEqual(parseYaml("- one\n- two\n"), ["one", "two"]);
});

test("tabs are rejected with a line number", () => {
  assert.throws(() => parseYaml("a: 1\n\tb: 2\n"), (error: unknown) => {
    assert.ok(error instanceof YamlError);
    assert.equal(error.line, 2);
    assert.match(error.message, /tabs/);
    return true;
  });
});

test("non-empty flow collections are rejected rather than silently mis-parsed", () => {
  assert.throws(() => parseYaml("watch: [src, test]"), YamlError);
  assert.throws(() => parseYaml("check: {name: a}"), YamlError);
});

test("empty flow collections are supported, since init emits them", () => {
  assert.deepEqual(parseYaml("checks: []\nwatch: []\n"), { checks: [], watch: [] });
  assert.deepEqual(parseYaml("empty: {}"), { empty: {} });
});

test("document markers are rejected", () => {
  assert.throws(() => parseYaml("---\na: 1\n"), YamlError);
});

test("a malformed line is rejected with its line number", () => {
  assert.throws(() => parseYaml("a: 1\nthis is not yaml\n"), (error: unknown) => {
    assert.ok(error instanceof YamlError);
    assert.equal(error.line, 2);
    return true;
  });
});

test("bad indentation inside a list is rejected", () => {
  assert.throws(() => parseYaml("checks:\n  - name: a\n      run: b\n     oops: c\n"), YamlError);
});

// --- quoted scalars (regression: init produced corrupted commands) ---------

test("escapes inside a double-quoted string are resolved", () => {
  // The file on disk reads:  run: "node -e \"process.exit(1)\""
  assert.deepEqual(parseYaml('run: "node -e \\"process.exit(1)\\""'), {
    run: 'node -e "process.exit(1)"',
  });
});

test("a double-quoted string resolves escaped backslashes", () => {
  // The file on disk reads:  path: "C:\\Users\\x"
  assert.deepEqual(parseYaml('path: "C:\\\\Users\\\\x"'), { path: "C:\\Users\\x" });
});

test("the standard double-quote escapes are supported", () => {
  assert.deepEqual(parseYaml('a: "tab\\there"\nb: "nl\\nhere"\nc: "slash\\/here"\nd: "u\\u0041"'), {
    a: "tab\there",
    b: "nl\nhere",
    c: "slash/here",
    d: "uA",
  });
});

test("a single-quoted string escapes a quote by doubling it", () => {
  assert.deepEqual(parseYaml("run: 'echo it''s fine'"), { run: "echo it's fine" });
});

test("a single-quoted string keeps backslashes literally", () => {
  // The file on disk reads:  run: 'a\b'
  assert.deepEqual(parseYaml("run: 'a\\b'"), { run: "a\\b" });
});

test("double quotes inside a single-quoted string need no escaping", () => {
  assert.deepEqual(parseYaml(`run: 'node -e "process.exit(1)"'`), { run: 'node -e "process.exit(1)"' });
});

test("an unterminated quoted string is rejected", () => {
  assert.throws(() => parseYaml('run: "no end'), YamlError);
  assert.throws(() => parseYaml("run: 'no end"), YamlError);
});

test("content after a closing quote is rejected instead of being swallowed", () => {
  assert.throws(() => parseYaml('run: "a" and then b'), YamlError);
});

test("an unsupported escape is rejected rather than silently dropped", () => {
  assert.throws(() => parseYaml('run: "bad \\q escape"'), YamlError);
});

test("a dangling backslash is rejected", () => {
  assert.throws(() => parseYaml('run: "dangling \\'), YamlError);
});

test("an invalid unicode escape is rejected", () => {
  assert.throws(() => parseYaml('run: "\\uZZZZ"'), YamlError);
});

test("a leading UTF-8 BOM is ignored", () => {
  // Pinned here as well as in config.test.ts: both layers strip a BOM
  // independently, so a test that goes through loadConfig cannot fail when
  // only one of them breaks.
  const bom = String.fromCharCode(0xfeff);
  assert.deepEqual(parseYaml(`${bom}version: 1\nchecks: []\n`), { version: 1, checks: [] });
});
