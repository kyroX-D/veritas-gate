// Loading, validating and auto-detecting the veritas configuration.
//
// Two rules govern everything here:
//   1. Loading a config never throws. A broken config produces warnings and
//      falls back to safe defaults, because veritas must not block a session
//      over its own problems.
//   2. Auto-detection only proposes checks that the project actually declares
//      (npm scripts, Cargo.toml, go.mod, ...) so that a fresh install does not
//      start failing on commands nobody configured.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { parseYaml, YamlError, type YamlValue } from "./yaml.ts";

export interface Check {
  readonly name: string;
  readonly run: string;
  /** Seconds. */
  readonly timeout: number;
  readonly blocking: boolean;
}

export interface Config {
  readonly version: number;
  readonly checks: readonly Check[];
  readonly maxAttempts: number;
  readonly watch: readonly string[];
  readonly dryRun: boolean;
}

export type ConfigSource = "file" | "detected" | "none";

export interface LoadedConfig {
  readonly config: Config;
  /** Human-readable problems. Never fatal. */
  readonly warnings: readonly string[];
  readonly source: ConfigSource;
  /** Absolute path of the config file, when one was read. */
  readonly path: string | undefined;
}

export const CONFIG_FILENAMES = [".veritas.yml", ".veritas.yaml"] as const;

export const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * How many consecutive Stop-hook blocks veritas performs before it gives up and
 * escalates with a visible NOT VERIFIED report.
 *
 * This is a self-imposed limit, NOT a documented platform limit. The Claude Code
 * hooks reference does not state a maximum number of consecutive Stop-hook
 * blocks; it only exposes a `loop_protection_blocked` flag on the hook payload
 * telling a hook that Claude Code's own loop protection has already engaged.
 * veritas therefore honours that flag as authoritative and additionally caps
 * itself here, deliberately low, so that it escalates on its own terms rather
 * than being silently overridden. See NOTES.md section 3.
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

export const DEFAULT_CONFIG: Config = {
  version: 1,
  checks: [],
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  watch: [],
  dryRun: false,
};

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes a leading UTF-8 byte order mark.
 *
 * Editors and shells on Windows write BOMs freely; a BOM in front of `{` makes
 * JSON.parse throw, which would silently disable project detection.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return stripBom(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Turns raw parsed YAML into a Config. Every rejected value is reported by
 * field name in `warnings` and replaced by its default.
 */
export function validateConfig(raw: YamlValue): { config: Config; warnings: string[] } {
  const warnings: string[] = [];

  if (raw === null) {
    return { config: DEFAULT_CONFIG, warnings };
  }

  if (!isRecord(raw)) {
    warnings.push("config root must be a mapping of keys to values; ignoring the file");
    return { config: DEFAULT_CONFIG, warnings };
  }

  let version = DEFAULT_CONFIG.version;
  if (raw["version"] !== undefined && raw["version"] !== null) {
    if (typeof raw["version"] === "number") {
      version = raw["version"];
      if (version !== 1) {
        warnings.push(`"version": expected 1, got ${version}; reading it as version 1 anyway`);
      }
    } else {
      warnings.push(`"version": expected a number, got ${typeof raw["version"]}`);
    }
  }

  const checks = validateChecks(raw["checks"], warnings);

  let maxAttempts = DEFAULT_CONFIG.maxAttempts;
  const rawMaxAttempts = raw["max_attempts"];
  if (rawMaxAttempts !== undefined && rawMaxAttempts !== null) {
    if (typeof rawMaxAttempts === "number" && Number.isInteger(rawMaxAttempts) && rawMaxAttempts >= 1) {
      maxAttempts = rawMaxAttempts;
    } else {
      warnings.push(
        `"max_attempts": expected an integer >= 1, got ${JSON.stringify(rawMaxAttempts)}; using ${maxAttempts}`,
      );
    }
  }

  const watch: string[] = [];
  const rawWatch = raw["watch"];
  if (rawWatch !== undefined && rawWatch !== null) {
    if (Array.isArray(rawWatch)) {
      rawWatch.forEach((entry, index) => {
        if (typeof entry === "string" && entry.trim() !== "") {
          watch.push(entry.trim());
        } else {
          warnings.push(`"watch[${index}]": expected a non-empty string, got ${JSON.stringify(entry)}; ignoring it`);
        }
      });
    } else {
      warnings.push(`"watch": expected a list of glob patterns, got ${typeof rawWatch}; ignoring it`);
    }
  }

  let dryRun = DEFAULT_CONFIG.dryRun;
  const rawDryRun = raw["dry_run"];
  if (rawDryRun !== undefined && rawDryRun !== null) {
    if (typeof rawDryRun === "boolean") {
      dryRun = rawDryRun;
    } else {
      warnings.push(`"dry_run": expected true or false, got ${JSON.stringify(rawDryRun)}; using false`);
    }
  }

  for (const key of Object.keys(raw)) {
    if (!["version", "checks", "max_attempts", "watch", "dry_run"].includes(key)) {
      warnings.push(`"${key}": unknown option, ignoring it`);
    }
  }

  return { config: { version, checks, maxAttempts, watch, dryRun }, warnings };
}

function validateChecks(rawChecks: YamlValue | undefined, warnings: string[]): Check[] {
  if (rawChecks === undefined || rawChecks === null) {
    return [];
  }

  if (!Array.isArray(rawChecks)) {
    warnings.push(`"checks": expected a list, got ${typeof rawChecks}; no checks will run`);
    return [];
  }

  const checks: Check[] = [];
  const seen = new Set<string>();

  rawChecks.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`"checks[${index}]": expected a mapping with "name" and "run"; skipping it`);
      return;
    }

    const run = entry["run"];
    if (typeof run !== "string" || run.trim() === "") {
      warnings.push(`"checks[${index}].run": expected a non-empty command string; skipping this check`);
      return;
    }

    let name = `check-${index + 1}`;
    if (typeof entry["name"] === "string" && entry["name"].trim() !== "") {
      name = entry["name"].trim();
    } else if (entry["name"] !== undefined && entry["name"] !== null) {
      warnings.push(`"checks[${index}].name": expected a non-empty string; using "${name}"`);
    }

    if (seen.has(name)) {
      warnings.push(`"checks[${index}].name": duplicate name "${name}"; skipping this check`);
      return;
    }
    seen.add(name);

    let timeout = DEFAULT_TIMEOUT_SECONDS;
    const rawTimeout = entry["timeout"];
    if (rawTimeout !== undefined && rawTimeout !== null) {
      if (typeof rawTimeout === "number" && rawTimeout > 0) {
        timeout = rawTimeout;
      } else {
        warnings.push(
          `"checks[${index}].timeout": expected a positive number of seconds, got ${JSON.stringify(rawTimeout)}; using ${timeout}`,
        );
      }
    }

    let blocking = true;
    const rawBlocking = entry["blocking"];
    if (rawBlocking !== undefined && rawBlocking !== null) {
      if (typeof rawBlocking === "boolean") {
        blocking = rawBlocking;
      } else {
        warnings.push(
          `"checks[${index}].blocking": expected true or false, got ${JSON.stringify(rawBlocking)}; using true`,
        );
      }
    }

    for (const key of Object.keys(entry)) {
      if (!["name", "run", "timeout", "blocking"].includes(key)) {
        warnings.push(`"checks[${index}].${key}": unknown option, ignoring it`);
      }
    }

    checks.push({ name, run, timeout, blocking });
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

export interface Detection {
  readonly checks: readonly Check[];
  readonly watch: readonly string[];
  /** Ecosystems recognised in the project root, in detection order. */
  readonly ecosystems: readonly string[];
}

/** npm's placeholder test script, which must never become a blocking check. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;

export function detectProject(root: string): Detection {
  /** Each detected check together with the ecosystem that produced it. */
  const found: { check: Check; ecosystem: string }[] = [];
  const watch = new Set<string>();
  const ecosystems: string[] = [];

  const add = (ecosystem: string, check: Check): void => {
    found.push({ ecosystem, check });
  };

  // --- Node -----------------------------------------------------------------
  const packageJson = readJson(join(root, "package.json"));
  if (packageJson !== undefined) {
    ecosystems.push("node");

    const scripts =
      typeof packageJson["scripts"] === "object" && packageJson["scripts"] !== null
        ? (packageJson["scripts"] as Record<string, unknown>)
        : {};

    const script = (name: string): string | undefined => {
      const value = scripts[name];
      return typeof value === "string" && value.trim() !== "" ? value : undefined;
    };

    if (script("typecheck") !== undefined) {
      add("node", { name: "typecheck", run: "npm run typecheck", timeout: 120, blocking: true });
    }

    const testScript = script("test");
    if (testScript !== undefined && !NPM_PLACEHOLDER_TEST.test(testScript)) {
      add("node", { name: "test", run: "npm test", timeout: 300, blocking: true });
    }

    if (script("lint") !== undefined) {
      add("node", { name: "lint", run: "npm run lint", timeout: 60, blocking: false });
    }

    if (script("build") !== undefined) {
      add("node", { name: "build", run: "npm run build", timeout: 300, blocking: false });
    }

    for (const pattern of ["src/**", "lib/**", "test/**", "tests/**", "package.json"]) {
      watch.add(pattern);
    }
  }

  // --- Python ---------------------------------------------------------------
  const pyproject = readText(join(root, "pyproject.toml"));
  const isPython =
    pyproject !== undefined ||
    existsSync(join(root, "setup.py")) ||
    existsSync(join(root, "setup.cfg")) ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "pytest.ini")) ||
    existsSync(join(root, "tox.ini"));

  if (isPython) {
    ecosystems.push("python");

    add("python", { name: "test", run: "pytest -q", timeout: 300, blocking: true });

    if (pyproject !== undefined && /\bruff\b/.test(pyproject)) {
      add("python", { name: "lint", run: "ruff check .", timeout: 60, blocking: false });
    }

    if (pyproject !== undefined && /\bmypy\b/.test(pyproject)) {
      add("python", { name: "typecheck", run: "mypy .", timeout: 180, blocking: false });
    }

    for (const pattern of ["**/*.py", "pyproject.toml"]) {
      watch.add(pattern);
    }
  }

  // --- Rust -----------------------------------------------------------------
  if (existsSync(join(root, "Cargo.toml"))) {
    ecosystems.push("rust");
    add("rust", { name: "test", run: "cargo test", timeout: 600, blocking: true });
    add("rust", { name: "lint", run: "cargo clippy --all-targets", timeout: 300, blocking: false });

    for (const pattern of ["src/**", "tests/**", "Cargo.toml"]) {
      watch.add(pattern);
    }
  }

  // --- Go -------------------------------------------------------------------
  if (existsSync(join(root, "go.mod"))) {
    ecosystems.push("go");
    add("go", { name: "test", run: "go test ./...", timeout: 300, blocking: true });
    add("go", { name: "vet", run: "go vet ./...", timeout: 120, blocking: false });

    for (const pattern of ["**/*.go", "go.mod"]) {
      watch.add(pattern);
    }
  }

  // Check names must be unique: a polyglot repo legitimately produces two
  // checks called "test". Later duplicates take their ecosystem as a suffix.
  const deduped: Check[] = [];
  const used = new Set<string>();

  for (const { check, ecosystem } of found) {
    let name = check.name;

    if (used.has(name)) {
      name = `${check.name}-${ecosystem}`;
      let suffix = 2;
      while (used.has(name)) {
        name = `${check.name}-${ecosystem}-${suffix}`;
        suffix += 1;
      }
    }

    used.add(name);
    deduped.push({ ...check, name });
  }

  return { checks: deduped, watch: [...watch], ecosystems };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function findConfigFile(root: string): string | undefined {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(root, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Loads the effective configuration for `root`.
 *
 * Order: an existing config file wins; otherwise auto-detection; otherwise a
 * no-op config with zero checks. This function never throws.
 */
export function loadConfig(root: string): LoadedConfig {
  const path = findConfigFile(root);

  if (path === undefined) {
    const detection = detectProject(root);

    if (detection.checks.length === 0) {
      return { config: DEFAULT_CONFIG, warnings: [], source: "none", path: undefined };
    }

    return {
      config: { ...DEFAULT_CONFIG, checks: detection.checks, watch: detection.watch },
      warnings: [],
      source: "detected",
      path: undefined,
    };
  }

  let text: string;
  try {
    text = stripBom(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      warnings: [`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`],
      source: "none",
      path,
    };
  }

  let parsed: YamlValue;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    return {
      config: DEFAULT_CONFIG,
      warnings: [`could not parse ${path}: ${detail}; running with no checks`],
      source: "none",
      path,
    };
  }

  const { config, warnings } = validateConfig(parsed);
  return { config, warnings, source: "file", path };
}

// ---------------------------------------------------------------------------
// Serialisation (used by `veritas init`)
// ---------------------------------------------------------------------------

function quoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9_./\- ]+$/.test(value) ? value : JSON.stringify(value);
}

/** Renders a Config as the .veritas.yml text that `veritas init` writes. */
export function renderConfig(config: Config, detection?: Detection): string {
  const lines: string[] = [];

  lines.push("# veritas-gate configuration");
  lines.push("# https://github.com/veritas-gate/veritas-gate");
  if (detection !== undefined && detection.ecosystems.length > 0) {
    lines.push(`# Generated by \`veritas init\` (detected: ${detection.ecosystems.join(", ")}).`);
  }
  lines.push("# Bypass everything at any time with VERITAS_SKIP=1.");
  lines.push("");
  lines.push(`version: ${config.version}`);
  lines.push("");

  if (config.checks.length === 0) {
    lines.push("# No checks were detected. Add your own, for example:");
    lines.push("# checks:");
    lines.push("#   - name: test");
    lines.push("#     run: npm test");
    lines.push("#     timeout: 300");
    lines.push("#     blocking: true");
    lines.push("checks: []");
  } else {
    lines.push("checks:");
    for (const check of config.checks) {
      lines.push(`  - name: ${quoteIfNeeded(check.name)}`);
      lines.push(`    run: ${quoteIfNeeded(check.run)}`);
      lines.push(`    timeout: ${check.timeout}`);
      lines.push(`    blocking: ${check.blocking}${check.blocking ? "" : "     # reports, does not block"}`);
    }
  }

  lines.push("");
  lines.push("# Consecutive blocks before veritas gives up and escalates visibly.");
  lines.push("# This is veritas' own limit, not a documented Claude Code limit.");
  lines.push(`max_attempts: ${config.maxAttempts}`);
  lines.push("");

  if (config.watch.length === 0) {
    lines.push("# Skip checks when no matching file changed since the last green run.");
    lines.push("# An empty list means: always run the checks.");
    lines.push("watch: []");
  } else {
    lines.push("# Skip checks when no matching file changed since the last green run.");
    lines.push("watch:");
    for (const pattern of config.watch) {
      lines.push(`  - ${JSON.stringify(pattern)}`);
    }
  }

  lines.push("");
  lines.push("# Report everything, block nothing.");
  lines.push(`dry_run: ${config.dryRun}`);
  lines.push("");

  return lines.join("\n");
}

/** Builds the config `veritas init` should write for a project root. */
export function initialConfig(root: string): { config: Config; detection: Detection } {
  const detection = detectProject(root);
  return {
    config: {
      version: 1,
      checks: detection.checks,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      watch: detection.watch,
      dryRun: false,
    },
    detection,
  };
}
