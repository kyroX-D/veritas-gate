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

test("a package.json with a UTF-8 BOM is still detected", () => {
  const root = makeProject({
    "package.json": `﻿${JSON.stringify({ scripts: { test: "node --test" } })}`,
  });

  assert.deepEqual(detectProject(root).ecosystems, ["node"]);
  assert.deepEqual(names(detectProject(root).checks), ["test"]);
});

test("a .veritas.yml with a UTF-8 BOM is still parsed", () => {
  const root = makeProject({ ".veritas.yml": "﻿checks:\n  - name: t\n    run: echo hi\n" });
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
