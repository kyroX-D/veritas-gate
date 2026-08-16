// Verifies the plugin packaging against the documented Claude Code layout, and
// actually executes the command that hooks/hooks.json registers.
//
// This does not prove Claude Code loads the plugin — that needs the `claude`
// CLI. It does prove that the manifest is well-formed, that every declared path
// exists, and that the registered command produces valid Stop-hook JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The environment for a spawned veritas, minus this test runner's own markers.
 *
 * Node's test runner exports NODE_TEST_CONTEXT to its children. A check that
 * runs `node --test` inherits it, switches into child-reporter mode and exits 0
 * even when its tests fail — which would make these tests pass for entirely the
 * wrong reason.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  delete env["VERITAS_SKIP"];
  return env;
}

const readJson = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(pluginRoot, relative), "utf8")) as Record<string, unknown>;

// --- manifest --------------------------------------------------------------

test("the manifest lives at .claude-plugin/plugin.json", () => {
  assert.ok(existsSync(join(pluginRoot, ".claude-plugin", "plugin.json")));
});

test("the manifest declares a kebab-case name", () => {
  const manifest = readJson(".claude-plugin/plugin.json");
  assert.equal(manifest["name"], "veritas-gate");
  assert.match(String(manifest["name"]), /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("the manifest version matches package.json", () => {
  assert.equal(readJson(".claude-plugin/plugin.json")["version"], readJson("package.json")["version"]);
});

test(".claude-plugin contains only the manifest", () => {
  // Putting skills/ or hooks/ inside .claude-plugin/ is documented as wrong.
  for (const wrong of ["skills", "hooks", "commands"]) {
    assert.equal(existsSync(join(pluginRoot, ".claude-plugin", wrong)), false, `.claude-plugin/${wrong} must not exist`);
  }
});

test("components sit at the plugin root", () => {
  for (const path of ["hooks/hooks.json", "commands/verify.md", "commands/status.md", "skills/no-fabrication/SKILL.md"]) {
    assert.ok(existsSync(join(pluginRoot, path)), `${path} is missing`);
  }
});

// --- hook registration -----------------------------------------------------

interface HookHandler {
  type?: string;
  command?: string;
  args?: string[];
  timeout?: number;
}

function stopHandlers(): HookHandler[] {
  const config = readJson("hooks/hooks.json");
  const hooks = config["hooks"] as Record<string, { hooks?: HookHandler[] }[]>;
  const stop = hooks["Stop"];

  assert.ok(Array.isArray(stop), "hooks.json must register a Stop event");
  return stop.flatMap((matcher) => matcher.hooks ?? []);
}

test("hooks.json registers exactly one Stop command handler", () => {
  const handlers = stopHandlers();
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0]?.type, "command");
});

test("the handler uses exec form, which is the documented shape for plugin paths", () => {
  const handler = stopHandlers()[0];

  // Shell form would need manual quoting of a path containing spaces, which is
  // the normal case on Windows.
  assert.equal(handler?.command, "node");
  assert.ok(Array.isArray(handler?.args));
  assert.equal(handler?.args?.[1], "hook");
});

test("the script the handler points at exists in the built bundle", () => {
  const scriptArg = stopHandlers()[0]?.args?.[0] ?? "";

  assert.match(scriptArg, /^\$\{CLAUDE_PLUGIN_ROOT\}\//, "the path must be plugin-root relative");

  const resolved = join(pluginRoot, scriptArg.replace("${CLAUDE_PLUGIN_ROOT}/", ""));
  assert.ok(existsSync(resolved), `${resolved} does not exist - run npm run build`);
});

test("the handler declares a timeout", () => {
  assert.equal(typeof stopHandlers()[0]?.timeout, "number");
});

// --- commands and skill ----------------------------------------------------

function frontmatter(relative: string): Record<string, string> {
  const text = readFileSync(join(pluginRoot, relative), "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(match, `${relative} has no YAML frontmatter`);

  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (pair !== null) fields[pair[1] as string] = (pair[2] ?? "").trim();
  }
  return fields;
}

test("both commands declare a description", () => {
  for (const command of ["commands/verify.md", "commands/status.md"]) {
    assert.ok((frontmatter(command)["description"] ?? "").length > 0, `${command} needs a description`);
  }
});

test("the skill declares a name and a description", () => {
  const fields = frontmatter("skills/no-fabrication/SKILL.md");
  assert.equal(fields["name"], "no-fabrication");
  assert.ok((fields["description"] ?? "").length > 0);
});

test("the skill description stays well inside the 1536-character listing budget", () => {
  const description = frontmatter("skills/no-fabrication/SKILL.md")["description"] ?? "";
  assert.ok(description.length < 400, `description is ${description.length} chars; keep it short`);
});

test("the skill description carries the words that should trigger it", () => {
  const description = (frontmatter("skills/no-fabrication/SKILL.md")["description"] ?? "").toLowerCase();

  for (const trigger of ["done", "fixed", "working", "tested", "verified", "passing"]) {
    assert.ok(description.includes(trigger), `the description should mention "${trigger}"`);
  }
});

test("the skill forbids the specific evasions veritas cares about", () => {
  const body = readFileSync(join(pluginRoot, "skills/no-fabrication/SKILL.md"), "utf8");

  assert.match(body, /not tested/i);
  assert.match(body, /VERITAS_SKIP=1/);
  assert.match(body, /\.veritas\.yml/);
});

// --- the registered command actually runs ---------------------------------

test("the registered command produces a valid Stop-hook allow decision", () => {
  const handler = stopHandlers()[0];
  const script = join(pluginRoot, (handler?.args?.[0] ?? "").replace("${CLAUDE_PLUGIN_ROOT}/", ""));

  const project = mkdtempSync(join(tmpdir(), "veritas-plugin-"));

  try {
    // A project veritas knows nothing about: it must allow.
    const payload = JSON.stringify({
      session_id: "plugin-test",
      cwd: project,
      hook_event_name: "Stop",
      loop_protection_blocked: false,
    });

    const stdout = execFileSync("node", [script, "hook"], { input: payload, encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
    const output = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; decision?: string } };

    assert.equal(output.hookSpecificOutput?.hookEventName, "Stop");
    assert.equal(output.hookSpecificOutput?.decision, "allow");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the registered command produces a valid block decision on a red project", () => {
  const handler = stopHandlers()[0];
  const script = join(pluginRoot, (handler?.args?.[0] ?? "").replace("${CLAUDE_PLUGIN_ROOT}/", ""));

  const project = mkdtempSync(join(tmpdir(), "veritas-plugin-red-"));

  try {
    writeFileSync(
      join(project, ".veritas.yml"),
      `version: 1
checks:
  - name: test
    run: node -e "process.exit(1)"
    timeout: 30
    blocking: true
max_attempts: 3
`,
      "utf8",
    );

    const payload = JSON.stringify({
      session_id: "plugin-test-red",
      cwd: project,
      hook_event_name: "Stop",
      loop_protection_blocked: false,
    });

    const stdout = execFileSync("node", [script, "hook"], { input: payload, encoding: "utf8", env: cleanEnv(), timeout: 60_000 });
    const output = JSON.parse(stdout) as {
      hookSpecificOutput?: { decision?: string; reason?: string };
      systemMessage?: string;
    };

    assert.equal(output.hookSpecificOutput?.decision, "block");
    assert.match(output.hookSpecificOutput?.reason ?? "", /NOT verified/i);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// --- the example project ---------------------------------------------------

test("the example project is still red, which is the point of it", () => {
  // Copied to a temp directory rather than run in place: running it in the repo
  // leaves a .veritas/ state directory behind, and a stale green fingerprint in
  // it makes this test pass for the wrong reason.
  const source = join(pluginRoot, "examples", "failing-project");
  const workspace = mkdtempSync(join(tmpdir(), "veritas-example-"));
  const example = join(workspace, "failing-project");

  try {
    cpSync(source, example, { recursive: true });
    rmSync(join(example, ".veritas"), { recursive: true, force: true });

    const payload = JSON.stringify({
      session_id: "example-test",
      cwd: example,
      hook_event_name: "Stop",
      loop_protection_blocked: false,
    });

    const stdout = execFileSync("node", [join(pluginRoot, "dist", "veritas.mjs"), "hook"], {
      input: payload,
      encoding: "utf8", env: cleanEnv(),
      timeout: 120_000,
    });

    const output = JSON.parse(stdout) as { hookSpecificOutput?: { decision?: string; reason?: string } };

    assert.equal(output.hookSpecificOutput?.decision, "block", "examples/failing-project must fail its own test suite");
    assert.match(
      output.hookSpecificOutput?.reason ?? "",
      /3 !== 6/,
      "the example README quotes this assertion; keep them in sync",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the hook exits 0 even when it blocks, so a crash can never block by accident", () => {
  const script = join(pluginRoot, "dist", "veritas.mjs");
  const project = mkdtempSync(join(tmpdir(), "veritas-plugin-exit-"));

  try {
    writeFileSync(
      join(project, ".veritas.yml"),
      'version: 1\nchecks:\n  - name: test\n    run: node -e "process.exit(1)"\n    blocking: true\n',
      "utf8",
    );

    // execFileSync throws on a non-zero exit; reaching the assert proves exit 0.
    execFileSync("node", [script, "hook"], {
      input: JSON.stringify({ session_id: "exit-test", cwd: project, hook_event_name: "Stop" }),
      encoding: "utf8", env: cleanEnv(),
      timeout: 60_000,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
