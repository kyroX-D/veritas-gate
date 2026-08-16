// Check execution: spawning, timeouts and output capture.
//
// The runner distinguishes a check that genuinely failed from a check that
// could not run at all (missing tool, spawn error). Only the former is allowed
// to block a turn — blocking because a linter is not installed would be exactly
// the kind of false positive that gets a tool uninstalled.

import { spawn } from "node:child_process";
import { platform } from "node:process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { Check } from "./config.ts";

export type CheckStatus =
  /** Exit code 0. */
  | "passed"
  /** Non-zero exit code. This is the only status that may block. */
  | "failed"
  /** Killed after exceeding its timeout. */
  | "timed-out"
  /** The command itself does not exist on this machine. */
  | "unavailable"
  /** veritas could not spawn the process at all. */
  | "error";

export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly status: CheckStatus;
  /** null when the process never produced one (spawn failure or kill). */
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly blocking: boolean;
  readonly timeoutSeconds: number;
}

/** Per-stream capture cap. The tail is what matters, so the head is dropped. */
const MAX_CAPTURED_BYTES = 512 * 1024;

/**
 * POSIX shells use 127 for "command not found"; cmd.exe uses 9009 for
 * "is not recognized as an internal or external command".
 */
const COMMAND_NOT_FOUND_EXIT_CODES = new Set([127, 9009]);

/**
 * Extracts the program name from a shell command line.
 *
 * Returns undefined when the command is not a plain `program args...` form —
 * pipelines, environment prefixes and subshells are not worth guessing about.
 */
export function programName(command: string): string | undefined {
  const text = command.trim();
  if (text === "") return undefined;

  if (text.startsWith('"')) {
    const end = text.indexOf('"', 1);
    return end === -1 ? undefined : text.slice(1, end);
  }

  const token = text.split(/\s/)[0] ?? "";

  // `FOO=bar cmd`, `a|b`, `(sub)` and friends: don't try to resolve these.
  if (!/^[A-Za-z0-9_.@:+\-\\/]+$/.test(token)) return undefined;

  return token;
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the command's program exists on this machine.
 *
 * This replaces matching against the shell's "command not found" text, which is
 * localised — a German Windows says "ist entweder falsch geschrieben oder
 * konnte nicht gefunden werden" and matches no English pattern. Resolving PATH
 * ourselves is locale-independent.
 *
 * Returns true when the answer is unknown (unparseable command, shell builtin),
 * because "unknown" must never be reported as "missing".
 */
export function programExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const program = programName(command);
  if (program === undefined) return true;

  const extensions =
    platform === "win32"
      ? (env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
      : [""];

  const candidates = (base: string): string[] => [base, ...extensions.map((ext) => base + ext)];

  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) {
    return candidates(program).some(isExecutableFile);
  }

  const pathValue = env["PATH"] ?? env["Path"] ?? "";
  const directories = pathValue.split(delimiter).filter((entry) => entry !== "");

  for (const directory of directories) {
    for (const candidate of candidates(join(directory, program))) {
      if (existsSync(candidate) && isExecutableFile(candidate)) return true;
    }
  }

  // A shell builtin (echo, cd, set) resolves nowhere on PATH but runs fine.
  // Treating it as missing would be worse than treating it as present.
  return SHELL_BUILTINS.has(program.toLowerCase());
}

const SHELL_BUILTINS = new Set([
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
  "unset",
]);

/** Keeps only the last `limit` bytes of a growing string. */
class TailBuffer {
  #chunks: string[] = [];
  #length = 0;

  append(chunk: string): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;

    while (this.#length > MAX_CAPTURED_BYTES && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      this.#length -= dropped?.length ?? 0;
    }
  }

  toString(): string {
    return this.#chunks.join("");
  }
}

/**
 * POSIX only: a check runs in its own process group so a timeout can kill the
 * whole group. Without this, killing `sh -c "npm test"` reaps the shell and
 * leaves npm and node running, which is exactly the runaway process a timeout
 * exists to stop. On Windows the equivalent is taskkill /T.
 */
const DETACH_CHECKS = platform !== "win32";

/**
 * Kills a check's entire process tree.
 *
 * Neither platform propagates a signal from the shell to its children on its
 * own, so each needs its own mechanism.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;

  if (platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).unref();
    } catch {
      // Best effort; the timeout result is reported either way.
    }
    return;
  }

  try {
    // Negative pid targets the process group created by detached: true.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Runs a single check to completion. Never throws. */
export function runCheck(check: Check, options: RunOptions): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = new TailBuffer();
    const stderr = new TailBuffer();

    const finish = (status: CheckStatus, exitCode: number | null): void => {
      resolve({
        name: check.name,
        command: check.run,
        status,
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        blocking: check.blocking,
        timeoutSeconds: check.timeout,
      });
    };

    let child;
    try {
      child = spawn(check.run, {
        cwd: options.cwd,
        shell: true,
        env: {
          ...(options.env ?? process.env),
          // Prevents a check that itself runs Claude Code from recursing into
          // another veritas run.
          VERITAS_SKIP: "1",
        },
        windowsHide: true,
        detached: DETACH_CHECKS,
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
    }, check.timeout * 1000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.append(chunk));

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

      // A non-zero exit only means "missing tool" when the program genuinely
      // cannot be found. Everything else is a real failure.
      const looksMissing =
        (code !== null && COMMAND_NOT_FOUND_EXIT_CODES.has(code)) ||
        !programExists(check.run, options.env ?? process.env);

      finish(looksMissing ? "unavailable" : "failed", code);
    });
  });
}

/** Runs checks in order, stopping early once a blocking check has failed. */
export async function runChecks(
  checks: readonly Check[],
  options: RunOptions & { readonly stopOnFirstBlockingFailure?: boolean },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const check of checks) {
    const result = await runCheck(check, options);
    results.push(result);

    if (options.stopOnFirstBlockingFailure === true && isBlockingFailure(result)) {
      break;
    }
  }

  return results;
}

/**
 * Whether a result should prevent the agent from declaring completion.
 *
 * Deliberately narrow: only a check marked blocking that actually ran and
 * reported failure (or hit its own timeout) counts. A missing tool or a veritas
 * spawn error never blocks.
 */
export function isBlockingFailure(result: CheckResult): boolean {
  return result.blocking && (result.status === "failed" || result.status === "timed-out");
}

/** Problems worth telling the user about that must not block. */
export function isInfrastructureProblem(result: CheckResult): boolean {
  return result.status === "unavailable" || result.status === "error";
}
