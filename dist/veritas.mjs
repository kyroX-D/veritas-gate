#!/usr/bin/env node

// src/cli.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4, resolve } from "node:path";

// src/config.ts
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// src/yaml.ts
var YamlError = class extends Error {
  line;
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
};
var KEY_PATTERN = /^([A-Za-z0-9_.\-$]+)\s*:(?:\s+(.*))?$/;
function stripComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (char === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1] ?? "")) {
        return raw.slice(0, i);
      }
    }
  }
  return raw;
}
function toLines(source) {
  const lines = [];
  const withoutBom = source.charCodeAt(0) === 65279 ? source.slice(1) : source;
  withoutBom.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    if (raw.includes("	")) {
      throw new YamlError("tabs are not valid YAML indentation, use spaces", number);
    }
    const withoutComment = stripComment(raw);
    const text = withoutComment.trimEnd();
    if (text.trim() === "") {
      return;
    }
    if (text.trim() === "---" || text.trim() === "...") {
      throw new YamlError("document markers are not supported", number);
    }
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), number });
  });
  return lines;
}
function parseScalar(raw, line) {
  const text = raw.trim();
  if (text === "") {
    return null;
  }
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2 || text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1);
  }
  if (text === "[]") return [];
  if (text === "{}") return {};
  if (text.startsWith("[") || text.startsWith("{")) {
    throw new YamlError("non-empty flow collections ([...] and {...}) are not supported", line);
  }
  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return Number.parseFloat(text);
  }
  return text;
}
function parseBlock(lines, start, indent) {
  const first = lines[start];
  if (first === void 0) {
    return { value: null, next: start };
  }
  return first.text.startsWith("- ") || first.text === "-" ? parseSequence(lines, start, indent) : parseMapping(lines, start, indent);
}
function parseSequence(lines, start, indent) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === void 0 || line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside a list", line.number);
    }
    if (!line.text.startsWith("- ") && line.text !== "-") {
      throw new YamlError(`expected a list item starting with "- "`, line.number);
    }
    const inline = line.text === "-" ? "" : line.text.slice(2).trim();
    index += 1;
    const inlineKey = KEY_PATTERN.exec(inline);
    if (inlineKey !== null) {
      const keyIndent = line.indent + 2;
      const synthetic = [{ indent: keyIndent, text: inline, number: line.number }];
      while (index < lines.length) {
        const continuation = lines[index];
        if (continuation === void 0 || continuation.indent < keyIndent) break;
        if (continuation.text.startsWith("- ") && continuation.indent === keyIndent) break;
        synthetic.push(continuation);
        index += 1;
      }
      items.push(parseMapping(synthetic, 0, keyIndent).value);
      continue;
    }
    if (inline === "") {
      const nested = lines[index];
      if (nested !== void 0 && nested.indent > line.indent) {
        const parsed = parseBlock(lines, index, nested.indent);
        items.push(parsed.value);
        index = parsed.next;
        continue;
      }
      items.push(null);
      continue;
    }
    items.push(parseScalar(inline, line.number));
  }
  return { value: items, next: index };
}
function parseMapping(lines, start, indent) {
  const result = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line === void 0 || line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation", line.number);
    }
    if (line.text.startsWith("- ")) {
      break;
    }
    const match = KEY_PATTERN.exec(line.text);
    if (match === null) {
      throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.number);
    }
    const key = match[1];
    const inlineValue = match[2];
    index += 1;
    if (inlineValue !== void 0 && inlineValue.trim() !== "") {
      result[key] = parseScalar(inlineValue, line.number);
      continue;
    }
    const child = lines[index];
    if (child === void 0 || child.indent <= line.indent) {
      if (child !== void 0 && child.indent === line.indent && child.text.startsWith("- ")) {
        const parsed2 = parseSequence(lines, index, child.indent);
        result[key] = parsed2.value;
        index = parsed2.next;
        continue;
      }
      result[key] = null;
      continue;
    }
    const parsed = parseBlock(lines, index, child.indent);
    result[key] = parsed.value;
    index = parsed.next;
  }
  return { value: result, next: index };
}
function parseYaml(source) {
  const lines = toLines(source);
  if (lines.length === 0) {
    return null;
  }
  const firstIndent = lines[0]?.indent ?? 0;
  const { value, next } = parseBlock(lines, 0, firstIndent);
  if (next < lines.length) {
    throw new YamlError("unexpected content after the end of the document", lines[next]?.number ?? 0);
  }
  return value;
}

// src/config.ts
var CONFIG_FILENAMES = [".veritas.yml", ".veritas.yaml"];
var DEFAULT_TIMEOUT_SECONDS = 120;
var DEFAULT_MAX_ATTEMPTS = 3;
var DEFAULT_CONFIG = {
  version: 1,
  checks: [],
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  watch: [],
  dryRun: false
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stripBom(text) {
  return text.charCodeAt(0) === 65279 ? text.slice(1) : text;
}
function readJson(path) {
  try {
    const parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
    return typeof parsed === "object" && parsed !== null ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function readText(path) {
  try {
    return stripBom(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}
function validateConfig(raw) {
  const warnings = [];
  if (raw === null) {
    return { config: DEFAULT_CONFIG, warnings };
  }
  if (!isRecord(raw)) {
    warnings.push("config root must be a mapping of keys to values; ignoring the file");
    return { config: DEFAULT_CONFIG, warnings };
  }
  let version = DEFAULT_CONFIG.version;
  if (raw["version"] !== void 0 && raw["version"] !== null) {
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
  if (rawMaxAttempts !== void 0 && rawMaxAttempts !== null) {
    if (typeof rawMaxAttempts === "number" && Number.isInteger(rawMaxAttempts) && rawMaxAttempts >= 1) {
      maxAttempts = rawMaxAttempts;
    } else {
      warnings.push(
        `"max_attempts": expected an integer >= 1, got ${JSON.stringify(rawMaxAttempts)}; using ${maxAttempts}`
      );
    }
  }
  const watch = [];
  const rawWatch = raw["watch"];
  if (rawWatch !== void 0 && rawWatch !== null) {
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
  if (rawDryRun !== void 0 && rawDryRun !== null) {
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
function validateChecks(rawChecks, warnings) {
  if (rawChecks === void 0 || rawChecks === null) {
    return [];
  }
  if (!Array.isArray(rawChecks)) {
    warnings.push(`"checks": expected a list, got ${typeof rawChecks}; no checks will run`);
    return [];
  }
  const checks = [];
  const seen = /* @__PURE__ */ new Set();
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
    } else if (entry["name"] !== void 0 && entry["name"] !== null) {
      warnings.push(`"checks[${index}].name": expected a non-empty string; using "${name}"`);
    }
    if (seen.has(name)) {
      warnings.push(`"checks[${index}].name": duplicate name "${name}"; skipping this check`);
      return;
    }
    seen.add(name);
    let timeout = DEFAULT_TIMEOUT_SECONDS;
    const rawTimeout = entry["timeout"];
    if (rawTimeout !== void 0 && rawTimeout !== null) {
      if (typeof rawTimeout === "number" && rawTimeout > 0) {
        timeout = rawTimeout;
      } else {
        warnings.push(
          `"checks[${index}].timeout": expected a positive number of seconds, got ${JSON.stringify(rawTimeout)}; using ${timeout}`
        );
      }
    }
    let blocking = true;
    const rawBlocking = entry["blocking"];
    if (rawBlocking !== void 0 && rawBlocking !== null) {
      if (typeof rawBlocking === "boolean") {
        blocking = rawBlocking;
      } else {
        warnings.push(
          `"checks[${index}].blocking": expected true or false, got ${JSON.stringify(rawBlocking)}; using true`
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
var NPM_PLACEHOLDER_TEST = /no test specified/i;
function detectProject(root) {
  const found = [];
  const watch = /* @__PURE__ */ new Set();
  const ecosystems = [];
  const add = (ecosystem, check) => {
    found.push({ ecosystem, check });
  };
  const packageJson = readJson(join(root, "package.json"));
  if (packageJson !== void 0) {
    ecosystems.push("node");
    const scripts = typeof packageJson["scripts"] === "object" && packageJson["scripts"] !== null ? packageJson["scripts"] : {};
    const script = (name) => {
      const value = scripts[name];
      return typeof value === "string" && value.trim() !== "" ? value : void 0;
    };
    if (script("typecheck") !== void 0) {
      add("node", { name: "typecheck", run: "npm run typecheck", timeout: 120, blocking: true });
    }
    const testScript = script("test");
    if (testScript !== void 0 && !NPM_PLACEHOLDER_TEST.test(testScript)) {
      add("node", { name: "test", run: "npm test", timeout: 300, blocking: true });
    }
    if (script("lint") !== void 0) {
      add("node", { name: "lint", run: "npm run lint", timeout: 60, blocking: false });
    }
    if (script("build") !== void 0) {
      add("node", { name: "build", run: "npm run build", timeout: 300, blocking: false });
    }
    for (const pattern of ["src/**", "lib/**", "test/**", "tests/**", "package.json"]) {
      watch.add(pattern);
    }
  }
  const pyproject = readText(join(root, "pyproject.toml"));
  const isPython = pyproject !== void 0 || existsSync(join(root, "setup.py")) || existsSync(join(root, "setup.cfg")) || existsSync(join(root, "requirements.txt")) || existsSync(join(root, "pytest.ini")) || existsSync(join(root, "tox.ini"));
  if (isPython) {
    ecosystems.push("python");
    add("python", { name: "test", run: "pytest -q", timeout: 300, blocking: true });
    if (pyproject !== void 0 && /\bruff\b/.test(pyproject)) {
      add("python", { name: "lint", run: "ruff check .", timeout: 60, blocking: false });
    }
    if (pyproject !== void 0 && /\bmypy\b/.test(pyproject)) {
      add("python", { name: "typecheck", run: "mypy .", timeout: 180, blocking: false });
    }
    for (const pattern of ["**/*.py", "pyproject.toml"]) {
      watch.add(pattern);
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    ecosystems.push("rust");
    add("rust", { name: "test", run: "cargo test", timeout: 600, blocking: true });
    add("rust", { name: "lint", run: "cargo clippy --all-targets", timeout: 300, blocking: false });
    for (const pattern of ["src/**", "tests/**", "Cargo.toml"]) {
      watch.add(pattern);
    }
  }
  if (existsSync(join(root, "go.mod"))) {
    ecosystems.push("go");
    add("go", { name: "test", run: "go test ./...", timeout: 300, blocking: true });
    add("go", { name: "vet", run: "go vet ./...", timeout: 120, blocking: false });
    for (const pattern of ["**/*.go", "go.mod"]) {
      watch.add(pattern);
    }
  }
  const deduped = [];
  const used = /* @__PURE__ */ new Set();
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
function findConfigFile(root) {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(root, filename);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return void 0;
}
function loadConfig(root) {
  const path = findConfigFile(root);
  if (path === void 0) {
    const detection = detectProject(root);
    if (detection.checks.length === 0) {
      return { config: DEFAULT_CONFIG, warnings: [], source: "none", path: void 0 };
    }
    return {
      config: { ...DEFAULT_CONFIG, checks: detection.checks, watch: detection.watch },
      warnings: [],
      source: "detected",
      path: void 0
    };
  }
  let text;
  try {
    text = stripBom(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      warnings: [`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`],
      source: "none",
      path
    };
  }
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const detail = error instanceof YamlError ? error.message : String(error);
    return {
      config: DEFAULT_CONFIG,
      warnings: [`could not parse ${path}: ${detail}; running with no checks`],
      source: "none",
      path
    };
  }
  const { config, warnings } = validateConfig(parsed);
  return { config, warnings, source: "file", path };
}
function quoteIfNeeded(value) {
  return /^[A-Za-z0-9_./\- ]+$/.test(value) ? value : JSON.stringify(value);
}
function renderConfig(config, detection) {
  const lines = [];
  lines.push("# veritas-gate configuration");
  lines.push("# https://github.com/veritas-gate/veritas-gate");
  if (detection !== void 0 && detection.ecosystems.length > 0) {
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
function initialConfig(root) {
  const detection = detectProject(root);
  return {
    config: {
      version: 1,
      checks: detection.checks,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      watch: detection.watch,
      dryRun: false
    },
    detection
  };
}

// src/runner.ts
import { spawn } from "node:child_process";
import { platform } from "node:process";
import { existsSync as existsSync2, statSync } from "node:fs";
import { delimiter, isAbsolute, join as join2 } from "node:path";
var MAX_CAPTURED_BYTES = 512 * 1024;
var COMMAND_NOT_FOUND_EXIT_CODES = /* @__PURE__ */ new Set([127, 9009]);
function programName(command) {
  const text = command.trim();
  if (text === "") return void 0;
  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end === -1 ? void 0 : text.slice(1, end);
  }
  const token = text.split(/\s/)[0] ?? "";
  if (!/^[A-Za-z0-9_.@:+\-\\/]+$/.test(token)) return void 0;
  return token;
}
function isExecutableFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function programExists(command, env = process.env) {
  const program = programName(command);
  if (program === void 0) return true;
  const extensions = platform === "win32" ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "") : [""];
  const candidates = (base) => [base, ...extensions.map((ext) => base + ext)];
  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) {
    return candidates(program).some(isExecutableFile);
  }
  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const directories = pathValue.split(delimiter).filter((entry) => entry !== "");
  for (const directory of directories) {
    for (const candidate of candidates(join2(directory, program))) {
      if (existsSync2(candidate) && isExecutableFile(candidate)) return true;
    }
  }
  return SHELL_BUILTINS.has(program.toLowerCase());
}
var SHELL_BUILTINS = /* @__PURE__ */ new Set([
  "cd",
  "echo",
  "set",
  "type",
  "dir",
  "copy",
  "del",
  "exit",
  "if",
  "for",
  "call",
  "rem",
  "true",
  "false",
  "test",
  "export",
  "source",
  "eval",
  "pwd",
  "read",
  "unset"
]);
var TailBuffer = class {
  #chunks = [];
  #length = 0;
  append(chunk) {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    while (this.#length > MAX_CAPTURED_BYTES && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      this.#length -= dropped?.length ?? 0;
    }
  }
  toString() {
    return this.#chunks.join("");
  }
};
function killTree(pid) {
  if (pid === void 0) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } catch {
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
  }
}
function runCheck(check, options) {
  return new Promise((resolve2) => {
    const startedAt = Date.now();
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();
    const finish = (status, exitCode) => {
      resolve2({
        name: check.name,
        command: check.run,
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        blocking: check.blocking,
        timeoutSeconds: check.timeout
      });
    };
    let child;
    try {
      child = spawn(check.run, {
        cwd: options.cwd,
        shell: true,
        env: {
          ...options.env ?? process.env,
          // Prevents a check that itself runs Claude Code from recursing into
          // another veritas run.
          VERITAS_SKIP: "1"
        },
        windowsHide: true
      });
    } catch (error) {
      stderr.append(error instanceof Error ? error.message : String(error));
      finish("error", null);
      return;
    }
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, check.timeout * 1e3);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => stdout.append(chunk));
    child.stderr?.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stderr.append(error.message);
      finish("error", null);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        finish("timed-out", code);
        return;
      }
      if (code === 0) {
        finish("passed", 0);
        return;
      }
      const looksMissing = code !== null && COMMAND_NOT_FOUND_EXIT_CODES.has(code) || !programExists(check.run, options.env ?? process.env);
      finish(looksMissing ? "unavailable" : "failed", code);
    });
  });
}
async function runChecks(checks, options) {
  const results = [];
  for (const check of checks) {
    const result = await runCheck(check, options);
    results.push(result);
    if (options.stopOnFirstBlockingFailure === true && isBlockingFailure(result)) {
      break;
    }
  }
  return results;
}
function isBlockingFailure(result) {
  return result.blocking && (result.status === "failed" || result.status === "timed-out");
}
function isInfrastructureProblem(result) {
  return result.status === "unavailable" || result.status === "error";
}

// src/ledger.ts
import { appendFileSync, mkdirSync, readFileSync as readFileSync2, existsSync as existsSync3, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join as join3 } from "node:path";
var VERITAS_DIR = ".veritas";
var LEDGER_FILENAME = "ledger.jsonl";
var LEDGER_OUTPUT_LINES = 50;
var LEDGER_OUTPUT_CHARS = 8e3;
function veritasDir(root) {
  return join3(root, VERITAS_DIR);
}
function ledgerPath(root) {
  return join3(veritasDir(root), LEDGER_FILENAME);
}
function ensureVeritasDir(root) {
  const dir = veritasDir(root);
  mkdirSync(dir, { recursive: true });
  const gitignore = join3(dir, ".gitignore");
  if (!existsSync3(gitignore)) {
    writeFileSync(gitignore, "# Created by veritas-gate. Local evidence, never committed.\n*\n", "utf8");
  }
}
function truncateOutput(text, lines = LEDGER_OUTPUT_LINES, chars = LEDGER_OUTPUT_CHARS) {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "";
  const all = trimmed.split(/\r?\n/);
  const kept = all.length > lines ? all.slice(-lines) : all;
  let result = kept.join("\n");
  if (all.length > lines) {
    result = `[... ${all.length - lines} earlier lines omitted ...]
${result}`;
  }
  if (result.length > chars) {
    result = `[... output truncated ...]
${result.slice(-chars)}`;
  }
  return result;
}
function combinedOutput(result) {
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (out !== "" && err !== "") return `${out}
${err}`;
  return out !== "" ? out : err;
}
function currentCommit(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function toEntry(result, trigger, gitCommit) {
  return {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    trigger,
    check: result.name,
    command: result.command,
    status: result.status,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    blocking: result.blocking,
    output: truncateOutput(combinedOutput(result)),
    git_commit: gitCommit
  };
}
function appendEntries(root, entries) {
  if (entries.length === 0) return true;
  try {
    ensureVeritasDir(root);
    const payload = entries.map((entry) => `${JSON.stringify(entry)}
`).join("");
    appendFileSync(ledgerPath(root), payload, "utf8");
    return true;
  } catch {
    return false;
  }
}
function recordResults(root, results, trigger) {
  const commit = currentCommit(root);
  return appendEntries(
    root,
    results.map((result) => toEntry(result, trigger, commit))
  );
}
function readEntries(root, limit = 20) {
  const path = ledgerPath(root);
  if (!existsSync3(path)) return [];
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "check" in parsed && "status" in parsed) {
        entries.push(parsed);
      }
    } catch {
    }
  }
  return limit > 0 ? entries.slice(-limit) : entries;
}

// src/format.ts
var BLOCK_REASON_LINES = 50;
var MARKERS = {
  passed: "[ pass ]",
  failed: "[ FAIL ]",
  "timed-out": "[ TIME ]",
  unavailable: "[ n/a  ]",
  error: "[ err  ]"
};
function formatDuration(ms) {
  if (ms < 1e3) return `${ms}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  const minutes = Math.floor(ms / 6e4);
  const seconds = Math.round(ms % 6e4 / 1e3);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}
function describe(result) {
  switch (result.status) {
    case "passed":
      return "";
    case "failed":
      return `exit ${result.exitCode ?? "unknown"}`;
    case "timed-out":
      return `timed out after ${result.timeoutSeconds}s`;
    case "unavailable":
      return "command not available on this machine";
    case "error":
      return "veritas could not run this check";
  }
}
function formatResultLine(result) {
  const marker = MARKERS[result.status];
  const detail = describe(result);
  const suffix = detail === "" ? "" : ` - ${detail}`;
  const nonBlocking = result.blocking ? "" : " (non-blocking)";
  return `${marker} ${result.name}${suffix} ${formatDuration(result.durationMs)}${nonBlocking}`;
}
function formatVerifyReport(results, context) {
  const lines = [];
  for (const warning of context.warnings ?? []) {
    lines.push(`warning: ${warning}`);
  }
  if ((context.warnings ?? []).length > 0) {
    lines.push("");
  }
  if (results.length === 0) {
    lines.push(noChecksMessage(context));
    return `${lines.join("\n")}
`;
  }
  for (const result of results) {
    lines.push(formatResultLine(result));
  }
  const failures = results.filter(isBlockingFailure);
  const infrastructure = results.filter(isInfrastructureProblem);
  const nonBlockingFailures = results.filter(
    (result) => !result.blocking && (result.status === "failed" || result.status === "timed-out")
  );
  lines.push("");
  if (failures.length > 0) {
    lines.push(`NOT VERIFIED: ${failures.length} blocking check(s) failed.`);
    lines.push("");
    for (const failure of failures) {
      lines.push(formatFailureDetail(failure));
    }
  } else {
    lines.push("VERIFIED: all blocking checks passed.");
  }
  if (nonBlockingFailures.length > 0) {
    lines.push("");
    lines.push(
      `Note: ${nonBlockingFailures.map((result) => result.name).join(", ")} failed but ${nonBlockingFailures.length === 1 ? "is" : "are"} configured as non-blocking.`
    );
  }
  if (infrastructure.length > 0) {
    lines.push("");
    for (const result of infrastructure) {
      lines.push(`Note: "${result.name}" did not run (${describe(result)}): ${result.command}`);
    }
  }
  return `${lines.join("\n")}
`;
}
function noChecksMessage(context) {
  switch (context.source) {
    case "file":
      return `No checks configured in ${context.configPath ?? ".veritas.yml"}. veritas is doing nothing.`;
    case "detected":
      return "No checks detected. veritas is doing nothing.";
    case "none":
      return [
        "veritas found no .veritas.yml and could not detect a known project layout,",
        "so it is running in no-op mode and will never block.",
        'Run "veritas init" to create a configuration.'
      ].join("\n");
  }
}
function formatFailureDetail(result, lines = BLOCK_REASON_LINES) {
  const output = truncateOutput(combinedOutput(result), lines);
  const header = result.status === "timed-out" ? `--- ${result.name}: timed out after ${result.timeoutSeconds}s ---` : `--- ${result.name}: exit code ${result.exitCode ?? "unknown"} ---`;
  return [header, `$ ${result.command}`, output === "" ? "(no output captured)" : output, ""].join("\n");
}
function formatStatus(entries, root) {
  if (entries.length === 0) {
    return [
      `No runs recorded yet in ${root}/.veritas/ledger.jsonl.`,
      'Run "veritas verify" to record one.',
      ""
    ].join("\n");
  }
  const lines = [`Last ${entries.length} run(s) from .veritas/ledger.jsonl:`, ""];
  const statusColumn = Math.max(...entries.map((entry) => entry.status.length));
  const nameColumn = Math.max(...entries.map((entry) => entry.check.length));
  for (const entry of [...entries].reverse()) {
    const when = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
    const status = entry.status.padEnd(statusColumn);
    const name = entry.check.padEnd(nameColumn);
    const exit = entry.exit_code === null ? "   -" : String(entry.exit_code).padStart(4);
    const commit = entry.git_commit === null ? "-------" : entry.git_commit.slice(0, 7);
    lines.push(
      `${when}  ${entry.trigger.padEnd(6)}  ${status}  ${name}  exit ${exit}  ${formatDuration(entry.duration_ms).padStart(7)}  ${commit}`
    );
  }
  const failing = entries.filter((entry) => entry.status === "failed" || entry.status === "timed-out");
  lines.push("");
  lines.push(
    failing.length === 0 ? "No failures in this window." : `${failing.length} failing run(s) in this window. Most recent: ${failing[failing.length - 1]?.check ?? ""}`
  );
  return `${lines.join("\n")}
`;
}

// src/cli.ts
var VERSION = "0.1.0";
var USAGE = `veritas-gate ${VERSION} - your agent doesn't get to say "done" without proof.

Usage:
  veritas init [--force]      Detect the project and write .veritas.yml
  veritas verify [--skip]     Run the configured checks now
  veritas status [--limit N]  Show recent runs from the evidence ledger
  veritas hook [--skip]       Stop-hook handler (reads hook JSON on stdin)

Options:
  -h, --help                  Show this help
  -v, --version               Show the version
  -C, --cwd <dir>             Use <dir> as the project root

Bypass:
  Set VERITAS_SKIP=1, or pass --skip, to let everything through without
  running any checks.
`;
async function readStdin() {
  if (process.stdin.isTTY === true) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
var defaultIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  stdin: readStdin
};
function skipRequested(argv, env) {
  if (argv.includes("--skip")) return true;
  const value = env["VERITAS_SKIP"];
  return value !== void 0 && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
function flagValue(argv, ...names) {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1) {
      return argv[index + 1];
    }
  }
  return void 0;
}
function resolveRoot(argv, io) {
  const explicit = flagValue(argv, "-C", "--cwd");
  return explicit === void 0 ? io.cwd : resolve(io.cwd, explicit);
}
async function commandInit(argv, io) {
  const root = resolveRoot(argv, io);
  const existing = findConfigFile(root);
  if (existing !== void 0 && !argv.includes("--force")) {
    io.stderr(`veritas: ${existing} already exists. Pass --force to overwrite it.
`);
    return 1;
  }
  const { config, detection } = initialConfig(root);
  const target = join4(root, CONFIG_FILENAMES[0]);
  try {
    writeFileSync2(target, renderConfig(config, detection), "utf8");
  } catch (error) {
    io.stderr(`veritas: could not write ${target}: ${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
  io.stdout(`Wrote ${target}
`);
  if (detection.ecosystems.length === 0) {
    io.stdout("\nNo known project layout was detected, so the config has no checks yet.\n");
    io.stdout("veritas will not block anything until you add some.\n");
    return 0;
  }
  io.stdout(`
Detected: ${detection.ecosystems.join(", ")}
`);
  if (detection.checks.length === 0) {
    io.stdout("No runnable checks were found, so the config has no checks yet.\n");
    return 0;
  }
  io.stdout("Checks:\n");
  for (const check of detection.checks) {
    io.stdout(`  ${check.name.padEnd(12)} ${check.run}${check.blocking ? "" : "   (non-blocking)"}
`);
  }
  io.stdout("\nReview the file, then run `veritas verify` to try it.\n");
  return 0;
}
async function commandVerify(argv, io) {
  const root = resolveRoot(argv, io);
  if (skipRequested(argv, io.env)) {
    io.stdout("veritas: skipped (VERITAS_SKIP or --skip). Nothing was verified.\n");
    return 0;
  }
  const loaded = loadConfig(root);
  if (loaded.config.checks.length === 0) {
    for (const warning of loaded.warnings) {
      io.stderr(`warning: ${warning}
`);
    }
    io.stdout(`${noChecksMessage({ source: loaded.source, configPath: loaded.path })}
`);
    return 0;
  }
  const results = await runChecks(loaded.config.checks, { cwd: root, env: io.env });
  if (!recordResults(root, results, "manual")) {
    io.stderr("warning: could not write to .veritas/ledger.jsonl\n");
  }
  io.stdout(
    formatVerifyReport(results, {
      source: loaded.source,
      configPath: loaded.path,
      warnings: loaded.warnings
    })
  );
  if (loaded.config.dryRun) {
    io.stdout("\ndry_run is enabled, so this result would not block a turn.\n");
    return 0;
  }
  return results.some(isBlockingFailure) ? 1 : 0;
}
async function commandStatus(argv, io) {
  const root = resolveRoot(argv, io);
  const rawLimit = flagValue(argv, "--limit", "-n");
  const parsed = rawLimit === void 0 ? Number.NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
  io.stdout(formatStatus(readEntries(root, limit), root));
  return 0;
}
async function commandHook(_argv, _io) {
  throw new Error("the hook handler is not implemented yet");
}
async function main(argv, io = defaultIo) {
  const command = argv[0];
  if (command === void 0 || command === "-h" || command === "--help") {
    io.stdout(USAGE);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    io.stdout(`${VERSION}
`);
    return 0;
  }
  const rest = argv.slice(1);
  switch (command) {
    case "init":
      return commandInit(rest, io);
    case "verify":
      return commandVerify(rest, io);
    case "status":
      return commandStatus(rest, io);
    case "hook":
      return commandHook(rest, io);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}
function isDirectRun() {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  return import.meta.url.endsWith(entry.replaceAll("\\", "/")) || import.meta.url === `file:///${entry.replaceAll("\\", "/")}`;
}
if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`veritas: ${error instanceof Error ? error.message : String(error)}
`);
      process.exitCode = 1;
    }
  );
}
export {
  USAGE,
  VERSION,
  main,
  readStdin,
  skipRequested
};
