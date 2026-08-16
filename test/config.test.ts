import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateConfig,
  detectProject,
  loadConfig,
  renderConfig,
  initialConfig,
  findConfigFile,
  findProjectRoot,
  isBypassed,
  yamlQuote,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SECONDS,
  type Check,
} from "../src/config.ts";
import { parseYaml } from "../src/yaml.ts";

const created: string[] = [];

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "veritas-cfg-"));
  created.push(root);

  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  return root;
}

process.on("exit", () => {
  for (const dir of created) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const names = (checks: readonly Check[]): string[] => checks.map((check) => check.name);

// --- validation ------------------------------------------------------------

test("a full valid config validates without warnings", () => {
  const { config, warnings } = validateConfig(
    parseYaml(`version: 1
checks:
  - name: test
    run: npm test
    timeout: 300
    blocking: true
max_attempts: 4
watch:
  - "src/**"
dry_run: false
`),
  );

  assert.deepEqual(warnings, []);
  assert.equal(config.maxAttempts, 4);
  assert.equal(config.dryRun, false);
  assert.deepEqual(config.watch, ["src/**"]);
  assert.deepEqual(config.checks, [{ name: "test", run: "npm test", timeout: 300, blocking: true }]);
});

test("an empty document yields defaults and no warnings", () => {
  const { config, warnings } = validateConfig(null);
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.checks, []);
  assert.equal(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
});

test("check defaults are applied when fields are omitted", () => {
  const { config, warnings } = validateConfig(parseYaml("checks:\n  - name: test\n    run: npm test\n"));
  assert.deepEqual(warnings, []);
  assert.deepEqual(config.checks[0], {
    name: "test",
    run: "npm test",
    timeout: DEFAULT_TIMEOUT_SECONDS,
    blocking: true,
  });
});

test("a check without a run command is skipped and named in the warning", () => {
  const { config, warnings } = validateConfig(parseYaml("checks:\n  - name: broken\n"));
  assert.deepEqual(config.checks, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /checks\[0\]\.run/);
});

test("an invalid timeout warns by field name and falls back to the default", () => {
  const { config, warnings } = validateConfig(
    parseYaml("checks:\n  - name: test\n    run: npm test\n    timeout: -5\n"),
  );
  assert.equal(config.checks[0]?.timeout, DEFAULT_TIMEOUT_SECONDS);
  assert.match(warnings[0] ?? "", /checks\[0\]\.timeout/);
});

test("an invalid blocking value warns and defaults to blocking", () => {
  const { config, warnings } = validateConfig(
    parseYaml("checks:\n  - name: test\n    run: npm test\n    blocking: maybe\n"),
  );
  assert.equal(config.checks[0]?.blocking, true);
  assert.match(warnings[0] ?? "", /checks\[0\]\.blocking/);
});

test("an invalid max_attempts warns and falls back", () => {
  const { config, warnings } = validateConfig(parseYaml("max_attempts: 0"));
  assert.equal(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.match(warnings[0] ?? "", /max_attempts/);
});

test("duplicate check names are rejected", () => {
  const { config, warnings } = validateConfig(
    parseYaml("checks:\n  - name: test\n    run: a\n  - name: test\n    run: b\n"),
  );
  assert.equal(config.checks.length, 1);
  assert.match(warnings[0] ?? "", /duplicate name "test"/);
});

test("unknown keys are reported but harmless", () => {
  const { config, warnings } = validateConfig(parseYaml("nonsense: 1\nmax_attempts: 2"));
  assert.equal(config.maxAttempts, 2);
  assert.match(warnings[0] ?? "", /"nonsense": unknown option/);
});

test("unknown per-check keys are reported", () => {
  const { warnings } = validateConfig(parseYaml("checks:\n  - name: t\n    run: x\n    retries: 3\n"));
  assert.match(warnings[0] ?? "", /checks\[0\]\.retries/);
});

test("a non-mapping root is refused without throwing", () => {
  const { config, warnings } = validateConfig(parseYaml("- a\n- b\n"));
  assert.deepEqual(config.checks, []);
  assert.match(warnings[0] ?? "", /must be a mapping/);
});

test("a bad watch entry is dropped and the rest kept", () => {
  const { config, warnings } = validateConfig(parseYaml('watch:\n  - "src/**"\n  - 42\n'));
  assert.deepEqual(config.watch, ["src/**"]);
  assert.match(warnings[0] ?? "", /watch\[1\]/);
});

// --- auto-detection --------------------------------------------------------

test("detects Node scripts and marks lint and build non-blocking", () => {
  const root = makeProject({
    "package.json": JSON.stringify({
      scripts: { typecheck: "tsc --noEmit", test: "node --test", lint: "eslint .", build: "tsc" },
    }),
  });

  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["node"]);
  assert.deepEqual(names(detection.checks), ["typecheck", "test", "lint", "build"]);

  const byName = Object.fromEntries(detection.checks.map((check) => [check.name, check]));
  assert.equal(byName["typecheck"]?.blocking, true);
  assert.equal(byName["test"]?.blocking, true);
  assert.equal(byName["lint"]?.blocking, false);
  assert.equal(byName["build"]?.blocking, false);
});

test("npm's placeholder test script never becomes a blocking check", () => {
  const root = makeProject({
    "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  });

  assert.deepEqual(detectProject(root).checks, []);
});

test("a package.json with no scripts detects the ecosystem but no checks", () => {
  const root = makeProject({ "package.json": JSON.stringify({ name: "x" }) });
  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["node"]);
  assert.deepEqual(detection.checks, []);
});

test("detects Python via pyproject and picks up ruff and mypy", () => {
  const root = makeProject({
    "pyproject.toml": '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
  });

  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["python"]);
  assert.deepEqual(names(detection.checks), ["test", "lint", "typecheck"]);
  assert.equal(detection.checks[0]?.run, "pytest -q");
});

test("detects Python via requirements.txt alone", () => {
  const root = makeProject({ "requirements.txt": "pytest\n" });
  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["python"]);
  assert.deepEqual(names(detection.checks), ["test"]);
});

test("detects Rust", () => {
  const root = makeProject({ "Cargo.toml": '[package]\nname = "x"\n' });
  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["rust"]);
  assert.deepEqual(names(detection.checks), ["test", "lint"]);
  assert.equal(detection.checks[0]?.run, "cargo test");
});

test("detects Go", () => {
  const root = makeProject({ "go.mod": "module example.com/x\n\ngo 1.22\n" });
  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["go"]);
  assert.deepEqual(names(detection.checks), ["test", "vet"]);
});

test("a polyglot repo gets unique check names", () => {
  const root = makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "go.mod": "module example.com/x\n",
  });

  const detection = detectProject(root);
  assert.deepEqual(detection.ecosystems, ["node", "go"]);
  assert.deepEqual(names(detection.checks), ["test", "test-go", "vet"]);
});

test("an empty directory detects nothing", () => {
  const root = makeProject({});
  const detection = detectProject(root);
  assert.deepEqual(detection.checks, []);
  assert.deepEqual(detection.ecosystems, []);
});

test("a malformed package.json does not throw", () => {
  const root = makeProject({ "package.json": "{ not json" });
  assert.deepEqual(detectProject(root).ecosystems, []);
});

// The BOM in these two tests is written as an explicit \uFEFF escape rather
// than a literal character. It is test data, not stray invisible Unicode, and
// spelling it out keeps it from being "cleaned" away by a tool or an editor —
// which would leave both tests passing while testing nothing.
const BOM = "\uFEFF";

test("a package.json with a UTF-8 BOM is still detected", () => {
  const root = makeProject({
    "package.json": `${BOM}${JSON.stringify({ scripts: { test: "node --test" } })}`,
  });

  assert.deepEqual(detectProject(root).ecosystems, ["node"]);
  assert.deepEqual(names(detectProject(root).checks), ["test"]);
});

test("a .veritas.yml with a UTF-8 BOM is still parsed", () => {
  const root = makeProject({ ".veritas.yml": BOM + "checks:\n  - name: t\n    run: echo hi\n" });
  const loaded = loadConfig(root);

  assert.equal(loaded.source, "file");
  assert.deepEqual(names(loaded.config.checks), ["t"]);
});

// --- loading ---------------------------------------------------------------

test("loadConfig reads .veritas.yml when present", () => {
  const root = makeProject({ ".veritas.yml": "checks:\n  - name: t\n    run: echo hi\n" });
  const loaded = loadConfig(root);
  assert.equal(loaded.source, "file");
  assert.equal(loaded.path, join(root, ".veritas.yml"));
  assert.deepEqual(names(loaded.config.checks), ["t"]);
});

test("loadConfig accepts the .yaml spelling", () => {
  const root = makeProject({ ".veritas.yaml": "checks:\n  - name: t\n    run: echo hi\n" });
  assert.equal(findConfigFile(root), join(root, ".veritas.yaml"));
  assert.equal(loadConfig(root).source, "file");
});

test("loadConfig falls back to detection when no file exists", () => {
  const root = makeProject({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
  const loaded = loadConfig(root);
  assert.equal(loaded.source, "detected");
  assert.deepEqual(names(loaded.config.checks), ["test"]);
});

test("loadConfig reports no-op mode for an unrecognised project", () => {
  const loaded = loadConfig(makeProject({}));
  assert.equal(loaded.source, "none");
  assert.deepEqual(loaded.config.checks, []);
  assert.deepEqual(loaded.warnings, []);
});

test("an unparseable config warns and yields zero checks instead of throwing", () => {
  const root = makeProject({ ".veritas.yml": "checks:\n\tbroken: true\n" });
  const loaded = loadConfig(root);
  assert.equal(loaded.source, "none");
  assert.deepEqual(loaded.config.checks, []);
  assert.match(loaded.warnings[0] ?? "", /could not parse/);
});

test("a config file wins over auto-detection", () => {
  const root = makeProject({
    "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
    ".veritas.yml": "checks:\n  - name: only-this\n    run: echo hi\n",
  });

  assert.deepEqual(names(loadConfig(root).config.checks), ["only-this"]);
});

// --- rendering -------------------------------------------------------------

test("rendered config round-trips through the parser", () => {
  const root = makeProject({
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "node --test", lint: "eslint ." } }),
  });

  const { config, detection } = initialConfig(root);
  const text = renderConfig(config, detection);

  const { config: reparsed, warnings } = validateConfig(parseYaml(text));
  assert.deepEqual(warnings, []);
  assert.deepEqual(reparsed.checks, config.checks);
  assert.deepEqual(reparsed.watch, config.watch);
  assert.equal(reparsed.maxAttempts, config.maxAttempts);
  assert.equal(reparsed.dryRun, false);
});

test("rendered config for an unknown project round-trips to zero checks", () => {
  const root = makeProject({});
  const { config, detection } = initialConfig(root);
  const { config: reparsed, warnings } = validateConfig(parseYaml(renderConfig(config, detection)));
  assert.deepEqual(warnings, []);
  assert.deepEqual(reparsed.checks, []);
});

test("rendered config mentions the bypass escape hatch", () => {
  const { config, detection } = initialConfig(makeProject({}));
  assert.match(renderConfig(config, detection), /VERITAS_SKIP=1/);
});

// --- YAML quoting (regression: init wrote commands it could not read back) --

test("yamlQuote leaves plain values bare", () => {
  assert.equal(yamlQuote("npm test"), "npm test");
  assert.equal(yamlQuote("cargo clippy --all-targets"), "cargo clippy --all-targets");
});

test("yamlQuote quotes values that would otherwise change meaning", () => {
  assert.equal(yamlQuote(""), "''");
  assert.equal(yamlQuote("true"), "'true'");
  assert.equal(yamlQuote("42"), "'42'");
  assert.equal(yamlQuote("# not a comment"), "'# not a comment'");
  assert.equal(yamlQuote("a: b"), "'a: b'");
  assert.equal(yamlQuote("trailing "), "'trailing '");
});

test("yamlQuote leaves quotes inside a plain scalar alone", () => {
  // A quote that does not start the scalar is an ordinary character in YAML,
  // so these need no quoting at all. The round-trip test below is what proves
  // it, rather than the shape of the output.
  assert.equal(yamlQuote('node -e "process.exit(1)"'), 'node -e "process.exit(1)"');
  assert.equal(yamlQuote("echo it's fine"), "echo it's fine");
});

test("yamlQuote quotes a value that opens with a quote character", () => {
  assert.equal(yamlQuote('"leading quote'), `'"leading quote'`);
  assert.equal(yamlQuote("'leading apostrophe"), "'''leading apostrophe'");
});

test("commands with quotes survive a full render and reparse", () => {
  const commands = [
    'node -e "process.exit(1)"',
    "echo 'single'",
    "npm run test:unit -- --reporter dot",
    'sh -c "a && b"',
    "echo hash # not a comment",
    `python -c 'print("hi")'`,
    "echo it's fine",
  ];

  for (const run of commands) {
    const config = {
      version: 1,
      checks: [{ name: "c", run, timeout: 30, blocking: true }],
      maxAttempts: 3,
      watch: ["src/**", "*.py"],
      dryRun: false,
    };

    const { config: reparsed, warnings } = validateConfig(parseYaml(renderConfig(config)));

    assert.deepEqual(warnings, [], `warnings for ${JSON.stringify(run)}`);
    assert.equal(reparsed.checks[0]?.run, run, `round-trip changed ${JSON.stringify(run)}`);
  }
});

test("a check name needing quotes also round-trips", () => {
  const config = {
    version: 1,
    checks: [{ name: "test: unit", run: "npm test", timeout: 30, blocking: true }],
    maxAttempts: 3,
    watch: [],
    dryRun: false,
  };

  const { config: reparsed, warnings } = validateConfig(parseYaml(renderConfig(config)));
  assert.deepEqual(warnings, []);
  assert.equal(reparsed.checks[0]?.name, "test: unit");
});

// --- the bypass switch -----------------------------------------------------

test("isBypassed honours --skip", () => {
  assert.equal(isBypassed(["--skip"], {}), true);
  assert.equal(isBypassed([], {}), false);
});

test("isBypassed treats the usual truthy values as a skip", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", "anything"]) {
    assert.equal(isBypassed([], { VERITAS_SKIP: value }), true, `${value} should skip`);
  }
});

test("isBypassed does not treat falsy values as a skip", () => {
  for (const value of ["", "0", "false", "FALSE", "no", "  "]) {
    assert.equal(isBypassed([], { VERITAS_SKIP: value }), false, `${value} should not skip`);
  }
});

// --- project root discovery ------------------------------------------------

test("findProjectRoot finds the config above a subdirectory", () => {
  const root = makeProject({ ".veritas.yml": "checks: []\n", "src/deep/a.ts": "a" });
  assert.equal(findProjectRoot(join(root, "src", "deep")), root);
});

test("findProjectRoot falls back to the git root when there is no config", () => {
  const root = makeProject({ ".git/HEAD": "ref: refs/heads/main\n", "src/a.ts": "a" });
  assert.equal(findProjectRoot(join(root, "src")), root);
});

test("findProjectRoot prefers a config over a higher git root", () => {
  const root = makeProject({
    ".git/HEAD": "ref: refs/heads/main\n",
    "packages/app/.veritas.yml": "checks: []\n",
    "packages/app/src/a.ts": "a",
  });

  assert.equal(findProjectRoot(join(root, "packages", "app", "src")), join(root, "packages", "app"));
});

test("findProjectRoot returns the starting directory when nothing is found", () => {
  const root = makeProject({ "a.txt": "a" });
  assert.equal(findProjectRoot(root), root);
});

test("loading from a subdirectory picks up the parent config", () => {
  const root = makeProject({
    ".veritas.yml": "checks:\n  - name: t\n    run: echo hi\n",
    "src/a.ts": "a",
  });

  const loaded = loadConfig(findProjectRoot(join(root, "src")));
  assert.equal(loaded.source, "file");
  assert.deepEqual(names(loaded.config.checks), ["t"]);
});
