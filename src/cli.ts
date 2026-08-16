// Entry point: init | verify | status | hook.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { initialConfig, renderConfig, loadConfig, CONFIG_FILENAMES, findConfigFile } from "./config.ts";
import { runChecks, isBlockingFailure } from "./runner.ts";
import { recordResults, readEntries } from "./ledger.ts";
import { formatVerifyReport, formatStatus, noChecksMessage } from "./format.ts";

export const VERSION = "0.1.0";

export const USAGE = `veritas-gate ${VERSION} - your agent doesn't get to say "done" without proof.

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

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdin: () => Promise<string>;
}

/** Reads all of stdin. Resolves to "" when nothing is piped in. */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) return "";

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const defaultIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
  stdin: readStdin,
};

/** True when the user has asked veritas to stand down. */
export function skipRequested(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (argv.includes("--skip")) return true;
  const value = env["VERITAS_SKIP"];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function flagValue(argv: readonly string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1) {
      return argv[index + 1];
    }
  }
  return undefined;
}

function resolveRoot(argv: readonly string[], io: Io): string {
  const explicit = flagValue(argv, "-C", "--cwd");
  return explicit === undefined ? io.cwd : resolve(io.cwd, explicit);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function commandInit(argv: readonly string[], io: Io): Promise<number> {
  const root = resolveRoot(argv, io);
  const existing = findConfigFile(root);

  if (existing !== undefined && !argv.includes("--force")) {
    io.stderr(`veritas: ${existing} already exists. Pass --force to overwrite it.\n`);
    return 1;
  }

  const { config, detection } = initialConfig(root);
  const target = join(root, CONFIG_FILENAMES[0]);

  try {
    writeFileSync(target, renderConfig(config, detection), "utf8");
  } catch (error) {
    io.stderr(`veritas: could not write ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  io.stdout(`Wrote ${target}\n`);

  if (detection.ecosystems.length === 0) {
    io.stdout("\nNo known project layout was detected, so the config has no checks yet.\n");
    io.stdout("veritas will not block anything until you add some.\n");
    return 0;
  }

  io.stdout(`\nDetected: ${detection.ecosystems.join(", ")}\n`);

  if (detection.checks.length === 0) {
    io.stdout("No runnable checks were found, so the config has no checks yet.\n");
    return 0;
  }

  io.stdout("Checks:\n");
  for (const check of detection.checks) {
    io.stdout(`  ${check.name.padEnd(12)} ${check.run}${check.blocking ? "" : "   (non-blocking)"}\n`);
  }
  io.stdout("\nReview the file, then run `veritas verify` to try it.\n");

  return 0;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

async function commandVerify(argv: readonly string[], io: Io): Promise<number> {
  const root = resolveRoot(argv, io);

  if (skipRequested(argv, io.env)) {
    io.stdout("veritas: skipped (VERITAS_SKIP or --skip). Nothing was verified.\n");
    return 0;
  }

  const loaded = loadConfig(root);

  if (loaded.config.checks.length === 0) {
    for (const warning of loaded.warnings) {
      io.stderr(`warning: ${warning}\n`);
    }
    io.stdout(`${noChecksMessage({ source: loaded.source, configPath: loaded.path })}\n`);
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
      warnings: loaded.warnings,
    }),
  );

  if (loaded.config.dryRun) {
    io.stdout("\ndry_run is enabled, so this result would not block a turn.\n");
    return 0;
  }

  return results.some(isBlockingFailure) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function commandStatus(argv: readonly string[], io: Io): Promise<number> {
  const root = resolveRoot(argv, io);
  const rawLimit = flagValue(argv, "--limit", "-n");
  const parsed = rawLimit === undefined ? Number.NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 20;

  io.stdout(formatStatus(readEntries(root, limit), root));
  return 0;
}

// ---------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------

async function commandHook(_argv: readonly string[], _io: Io): Promise<number> {
  throw new Error("the hook handler is not implemented yet");
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "-h" || command === "--help") {
    io.stdout(USAGE);
    return 0;
  }

  if (command === "-v" || command === "--version") {
    io.stdout(`${VERSION}\n`);
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

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url.endsWith(entry.replaceAll("\\", "/")) || import.meta.url === `file:///${entry.replaceAll("\\", "/")}`;
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`veritas: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
