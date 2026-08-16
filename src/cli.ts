// Entry point: init | verify | status | hook.

import { writeFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  initialConfig,
  renderConfig,
  loadConfig,
  isBypassed,
  findProjectRoot,
  CONFIG_FILENAMES,
  findConfigFile,
} from "./config.ts";
import { runChecks, isBlockingFailure } from "./runner.ts";
import { recordResults, readEntries } from "./ledger.ts";
import { formatVerifyReport, formatStatus, noChecksMessage } from "./format.ts";
import { handleHook } from "./hook.ts";

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

/** Flags that consume the following argument. */
const VALUE_FLAGS = new Set(["-C", "--cwd", "--limit", "-n"]);

/** Every flag the CLI understands, so a typo fails loudly. */
const KNOWN_FLAGS = new Set([
  "-h",
  "--help",
  "-v",
  "--version",
  "-C",
  "--cwd",
  "--skip",
  "--force",
  "--limit",
  "-n",
]);

/**
 * Splits argv into a subcommand and its arguments, allowing flags on either
 * side of the subcommand so that `veritas -C dir verify` works.
 */
export function splitArgv(argv: readonly string[]): { command: string | undefined; args: string[] } {
  let command: string | undefined;
  const args: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (token.startsWith("-")) {
      args.push(token);

      if (VALUE_FLAGS.has(token) && argv[i + 1] !== undefined) {
        args.push(argv[i + 1] as string);
        i += 1;
      }
      continue;
    }

    if (command === undefined) {
      command = token;
      continue;
    }

    args.push(token);
  }

  return { command, args };
}

/**
 * Rejects unrecognised flags.
 *
 * A silently ignored `--skpi` would look like a bypass that did not happen,
 * which is the worst possible way for a safety switch to fail.
 */
export function unknownFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!token.startsWith("-")) continue;

    if (!KNOWN_FLAGS.has(token)) return token;
    if (VALUE_FLAGS.has(token)) i += 1;
  }

  return undefined;
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

/** The directory the user pointed at, taken literally. */
function targetDir(argv: readonly string[], io: Io): string {
  const explicit = flagValue(argv, "-C", "--cwd");
  return explicit === undefined ? resolve(io.cwd) : resolve(io.cwd, explicit);
}

/**
 * The project root for commands that read an existing configuration.
 *
 * `init` deliberately does not use this: "initialise here" has to mean here,
 * not somewhere up the tree.
 */
function resolveRoot(argv: readonly string[], io: Io): string {
  return findProjectRoot(targetDir(argv, io));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function commandInit(argv: readonly string[], io: Io): Promise<number> {
  const root = targetDir(argv, io);
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

  if (isBypassed(argv, io.env)) {
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

async function commandHook(argv: readonly string[], io: Io): Promise<number> {
  const payload = await io.stdin();
  const output = await handleHook(payload, { argv, env: io.env, fallbackCwd: resolveRoot(argv, io) });

  io.stdout(`${JSON.stringify(output)}\n`);

  // Always 0. A non-zero exit from a Stop hook is itself a block signal, so
  // exiting non-zero on an internal error would block by accident.
  return 0;
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const { command, args } = splitArgv(argv);

  if (args.includes("-h") || args.includes("--help")) {
    io.stdout(USAGE);
    return 0;
  }

  // Checked before the no-command fallback, or `veritas --version` prints usage.
  if (args.includes("-v") || args.includes("--version")) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  if (command === undefined) {
    io.stdout(USAGE);
    return 0;
  }

  const bad = unknownFlag(args);
  if (bad !== undefined) {
    throw new Error(`unknown option: ${bad}`);
  }

  switch (command) {
    case "init":
      return commandInit(args, io);
    case "verify":
      return commandVerify(args, io);
    case "status":
      return commandStatus(args, io);
    case "hook":
      return commandHook(args, io);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

/**
 * Whether this module is the process entry point.
 *
 * String comparison against import.meta.url is not reliable: drive-letter case,
 * separators and URL escaping all differ between the two. pathToFileURL
 * normalises both sides the same way. Getting this wrong is silent and total —
 * the CLI would exit 0 having done nothing at all.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;

  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
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
