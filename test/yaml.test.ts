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
