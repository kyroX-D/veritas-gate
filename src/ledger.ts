// Append-only JSONL evidence log.
//
// Every check run — from the hook or from the CLI — lands here. The point is
// that "the tests passed" becomes a checkable claim rather than an assertion.

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import type { CheckResult, CheckStatus } from "./runner.ts";

export const VERITAS_DIR = ".veritas";
export const LEDGER_FILENAME = "ledger.jsonl";

export type Trigger = "hook" | "manual";

export interface LedgerEntry {
  /** ISO 8601, UTC. */
  readonly timestamp: string;
  readonly trigger: Trigger;
  readonly check: string;
  readonly command: string;
  readonly status: CheckStatus;
  readonly exit_code: number | null;
  readonly duration_ms: number;
  readonly blocking: boolean;
  /** Truncated combined stdout/stderr. */
  readonly output: string;
  /** HEAD commit hash, when the project is a git repository. */
  readonly git_commit: string | null;
}

/** Lines of captured output stored per ledger entry. */
const LEDGER_OUTPUT_LINES = 50;

/** Hard character cap per ledger entry, so one runaway check cannot bloat the file. */
const LEDGER_OUTPUT_CHARS = 8000;

export function veritasDir(root: string): string {
  return join(root, VERITAS_DIR);
}

export function ledgerPath(root: string): string {
  return join(veritasDir(root), LEDGER_FILENAME);
}

/**
 * Creates `.veritas/` and makes it self-ignoring.
 *
 * Writing `.veritas/.gitignore` rather than editing the project's own
 * `.gitignore` keeps veritas from modifying files it does not own.
 */
export function ensureVeritasDir(root: string): void {
  const dir = veritasDir(root);
  mkdirSync(dir, { recursive: true });

  const gitignore = join(dir, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, "# Created by veritas-gate. Local evidence, never committed.\n*\n", "utf8");
  }
}

/** Keeps the last `lines` lines, then hard-caps the character count. */
export function truncateOutput(text: string, lines = LEDGER_OUTPUT_LINES, chars = LEDGER_OUTPUT_CHARS): string {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed === "") return "";

  const all = trimmed.split(/\r?\n/);
  const kept = all.length > lines ? all.slice(-lines) : all;
  let result = kept.join("\n");

  if (all.length > lines) {
    result = `[... ${all.length - lines} earlier lines omitted ...]\n${result}`;
  }

  if (result.length > chars) {
    result = `[... output truncated ...]\n${result.slice(-chars)}`;
  }

  return result;
}

/** Combined stdout and stderr of a result, labelled when both are present. */
export function combinedOutput(result: CheckResult): string {
  const out = result.stdout.trim();
  const err = result.stderr.trim();

  if (out !== "" && err !== "") return `${out}\n${err}`;
  return out !== "" ? out : err;
}

/** Reads HEAD, or null when this is not a git repository. */
export function currentCommit(root: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

export function toEntry(result: CheckResult, trigger: Trigger, gitCommit: string | null): LedgerEntry {
  return {
    timestamp: new Date().toISOString(),
    trigger,
    check: result.name,
    command: result.command,
    status: result.status,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    blocking: result.blocking,
    output: truncateOutput(combinedOutput(result)),
    git_commit: gitCommit,
  };
}

/**
 * Appends entries to the ledger.
 *
 * Returns false when writing failed. Callers must treat a failed ledger write
 * as a warning, never as a reason to block.
 */
export function appendEntries(root: string, entries: readonly LedgerEntry[]): boolean {
  if (entries.length === 0) return true;

  try {
    ensureVeritasDir(root);
    const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
    appendFileSync(ledgerPath(root), payload, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Records a set of results. Convenience wrapper around toEntry + appendEntries. */
export function recordResults(root: string, results: readonly CheckResult[], trigger: Trigger): boolean {
  const commit = currentCommit(root);
  return appendEntries(
    root,
    results.map((result) => toEntry(result, trigger, commit)),
  );
}

/**
 * Reads the most recent entries, newest last.
 *
 * Unparseable lines are skipped rather than treated as an error: the ledger is
 * append-only, and a half-written final line must not make `veritas status`
 * fail.
 */
export function readEntries(root: string, limit = 20): LedgerEntry[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const entries: LedgerEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "check" in parsed && "status" in parsed) {
        entries.push(parsed as LedgerEntry);
      }
    } catch {
      // Skip damaged lines.
    }
  }

  return limit > 0 ? entries.slice(-limit) : entries;
}
