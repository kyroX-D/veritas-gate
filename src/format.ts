// Human-readable reports.
//
// Output is deliberately plain ASCII: these strings end up in Windows consoles,
// in hook JSON and in the agent's context, none of which reward box drawing.

import type { CheckResult } from "./runner.ts";
import { isBlockingFailure, isInfrastructureProblem } from "./runner.ts";
import { combinedOutput, truncateOutput, type LedgerEntry } from "./ledger.ts";
import type { ConfigSource } from "./config.ts";

/** Lines of real output included in a block reason. */
export const BLOCK_REASON_LINES = 50;

const MARKERS: Record<CheckResult["status"], string> = {
  passed: "[ pass ]",
  failed: "[ FAIL ]",
  "timed-out": "[ TIME ]",
  unavailable: "[ n/a  ]",
  error: "[ err  ]",
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function describe(result: CheckResult): string {
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

export function formatResultLine(result: CheckResult): string {
  const marker = MARKERS[result.status];
  const detail = describe(result);
  const suffix = detail === "" ? "" : ` - ${detail}`;
  const nonBlocking = result.blocking ? "" : " (non-blocking)";
  return `${marker} ${result.name}${suffix} ${formatDuration(result.durationMs)}${nonBlocking}`;
}

export interface ReportContext {
  readonly source: ConfigSource;
  readonly configPath?: string | undefined;
  readonly warnings?: readonly string[];
}

/** The report `veritas verify` prints. */
export function formatVerifyReport(results: readonly CheckResult[], context: ReportContext): string {
  const lines: string[] = [];

  for (const warning of context.warnings ?? []) {
    lines.push(`warning: ${warning}`);
  }

  if ((context.warnings ?? []).length > 0) {
    lines.push("");
  }

  if (results.length === 0) {
    lines.push(noChecksMessage(context));
    return `${lines.join("\n")}\n`;
  }

  for (const result of results) {
    lines.push(formatResultLine(result));
  }

  const failures = results.filter(isBlockingFailure);
  const infrastructure = results.filter(isInfrastructureProblem);
  const nonBlockingFailures = results.filter(
    (result) => !result.blocking && (result.status === "failed" || result.status === "timed-out"),
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
      `Note: ${nonBlockingFailures.map((result) => result.name).join(", ")} failed but ${nonBlockingFailures.length === 1 ? "is" : "are"} configured as non-blocking.`,
    );
  }

  if (infrastructure.length > 0) {
    lines.push("");
    for (const result of infrastructure) {
      lines.push(`Note: "${result.name}" did not run (${describe(result)}): ${result.command}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function noChecksMessage(context: ReportContext): string {
  switch (context.source) {
    case "file":
      return `No checks configured in ${context.configPath ?? ".veritas.yml"}. veritas is doing nothing.`;
    case "detected":
      return "No checks detected. veritas is doing nothing.";
    case "none":
      return [
        "veritas found no .veritas.yml and could not detect a known project layout,",
        "so it is running in no-op mode and will never block.",
        'Run "veritas init" to create a configuration.',
      ].join("\n");
  }
}

/** One failing check rendered with its real output. */
export function formatFailureDetail(result: CheckResult, lines = BLOCK_REASON_LINES): string {
  const output = truncateOutput(combinedOutput(result), lines);
  const header =
    result.status === "timed-out"
      ? `--- ${result.name}: timed out after ${result.timeoutSeconds}s ---`
      : `--- ${result.name}: exit code ${result.exitCode ?? "unknown"} ---`;

  return [header, `$ ${result.command}`, output === "" ? "(no output captured)" : output, ""].join("\n");
}

/**
 * The `reason` string handed back to Claude when the Stop hook blocks.
 *
 * It carries the real failure output precisely so the agent corrects the cause
 * instead of restating that the work is done.
 */
export function formatBlockReason(results: readonly CheckResult[], attempt: number, maxAttempts: number): string {
  const failures = results.filter(isBlockingFailure);

  const lines: string[] = [
    "veritas-gate: the task is NOT verified. Do not report it as complete.",
    "",
    `${failures.length} blocking check(s) failed (attempt ${attempt} of ${maxAttempts}):`,
    "",
  ];

  for (const failure of failures) {
    lines.push(formatFailureDetail(failure));
  }

  lines.push("Required next steps:");
  lines.push("1. Read the output above and fix the underlying cause.");
  lines.push("2. Re-run the failing command yourself and paste its real output.");
  lines.push(
    "3. Do NOT weaken, skip, delete or rewrite the checks, and do not edit .veritas.yml to make them pass. Fixing the check instead of the code is a failed task, not a completed one.",
  );
  lines.push("");
  lines.push(
    `If you believe the failure is unrelated to your change, say so explicitly and explain why, rather than claiming success. To bypass verification deliberately, the user can set VERITAS_SKIP=1.`,
  );

  return lines.join("\n");
}

/** The visible give-up report. veritas never gives up silently. */
export function formatNotVerified(results: readonly CheckResult[], attempts: number, reason: "attempts" | "loop-protection"): string {
  const failures = results.filter(isBlockingFailure);

  const cause =
    reason === "attempts"
      ? `veritas has blocked ${attempts} time(s) in a row and has reached max_attempts.`
      : "Claude Code's loop protection has engaged, so veritas will not block again.";

  const lines: string[] = [
    "=============================================",
    "  veritas-gate: NOT VERIFIED - GIVING UP",
    "=============================================",
    "",
    cause,
    "It is letting this turn end, but the work is NOT verified.",
    "",
    `Still failing: ${failures.map((result) => result.name).join(", ") || "(no blocking checks ran)"}`,
    "",
  ];

  for (const failure of failures) {
    lines.push(formatFailureDetail(failure, 20));
  }

  lines.push("Run `veritas verify` to see the full output, or check .veritas/ledger.jsonl.");

  return lines.join("\n");
}

/** The table `veritas status` prints. */
export function formatStatus(entries: readonly LedgerEntry[], root: string): string {
  if (entries.length === 0) {
    return [
      `No runs recorded yet in ${root}/.veritas/ledger.jsonl.`,
      'Run "veritas verify" to record one.',
      "",
    ].join("\n");
  }

  const lines: string[] = [`Last ${entries.length} run(s) from .veritas/ledger.jsonl:`, ""];

  const statusColumn = Math.max(...entries.map((entry) => entry.status.length));
  const nameColumn = Math.max(...entries.map((entry) => entry.check.length));

  for (const entry of [...entries].reverse()) {
    const when = entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "Z");
    const status = entry.status.padEnd(statusColumn);
    const name = entry.check.padEnd(nameColumn);
    const exit = entry.exit_code === null ? "   -" : String(entry.exit_code).padStart(4);
    const commit = entry.git_commit === null ? "-------" : entry.git_commit.slice(0, 7);

    lines.push(
      `${when}  ${entry.trigger.padEnd(6)}  ${status}  ${name}  exit ${exit}  ${formatDuration(entry.duration_ms).padStart(7)}  ${commit}`,
    );
  }

  const failing = entries.filter((entry) => entry.status === "failed" || entry.status === "timed-out");
  lines.push("");
  lines.push(
    failing.length === 0
      ? "No failures in this window."
      : `${failing.length} failing run(s) in this window. Most recent: ${failing[failing.length - 1]?.check ?? ""}`,
  );

  return `${lines.join("\n")}\n`;
}
