// The Stop-hook handler: hook JSON on stdin, hook JSON on stdout.
//
// It is a plain async function taking a string and returning an object, so the
// whole decision tree is testable from JSON fixtures without a running Claude
// Code instance.
//
// Protocol notes, all verified against the hooks reference (see NOTES.md):
//   - The Stop payload carries `loop_protection_blocked`, which tells a hook
//     that Claude Code's own loop protection has already engaged.
//   - A block is expressed as
//     hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason }.
//   - `reason` is the text shown to Claude; `systemMessage` is shown to the user.
//   - veritas never sets `continue: false` — that would end the session outright.

import { loadConfig, isBypassed, findProjectRoot } from "./config.ts";
import { runChecks, isBlockingFailure, isInfrastructureProblem, type CheckResult } from "./runner.ts";
import { recordResults } from "./ledger.ts";
import { formatBlockReason, formatNotVerified, formatResultLine } from "./format.ts";
import { readState, writeState, blocksFor, withBlock, withReset, withTouch, fingerprint } from "./state.ts";

export interface StopHookPayload {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly hook_event_name?: string;
  readonly last_assistant_message?: string;
  /** Documented Stop/SubagentStop field: Claude Code's loop protection engaged. */
  readonly loop_protection_blocked?: boolean;
  /**
   * Older name for the same idea. Not in the current docs; read defensively so
   * that a build still sending it is handled, and its absence is never an error.
   */
  readonly stop_hook_active?: boolean;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "Stop";
    decision: "allow" | "block";
    reason?: string;
  };
  /**
   * Also emitted at the top level. Only the hookSpecificOutput shape is
   * currently documented, but earlier Claude Code versions read `decision` and
   * `reason` here. Unknown fields are ignored, so the redundancy is free.
   */
  decision?: "block";
  reason?: string;
  systemMessage?: string;
}

export interface HookContext {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** Used when the payload carries no cwd. */
  readonly fallbackCwd: string;
  /**
   * Test seam. Overrides how checks are executed, which is what lets the test
   * suite prove that a runner crash cannot block a session.
   */
  readonly runner?: typeof runChecks;
}

function allow(systemMessage?: string): HookOutput {
  const output: HookOutput = { hookSpecificOutput: { hookEventName: "Stop", decision: "allow" } };
  if (systemMessage !== undefined) output.systemMessage = systemMessage;
  return output;
}

function block(reason: string, systemMessage: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason },
    decision: "block",
    reason,
    systemMessage,
  };
}

/**
 * Handles one Stop-hook invocation.
 *
 * Never throws: any internal error resolves to an allow decision carrying a
 * warning. veritas failing must not cost the user their turn.
 */
export async function handleHook(rawPayload: string, context: HookContext): Promise<HookOutput> {
  try {
    return await decide(rawPayload, context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return allow(`veritas-gate failed and let this turn through: ${detail}`);
  }
}

async function decide(rawPayload: string, context: HookContext): Promise<HookOutput> {
  // --- 1. Parse the payload -------------------------------------------------
  let payload: StopHookPayload = {};

  if (rawPayload.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(rawPayload);
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as StopHookPayload;
      }
    } catch {
      return allow("veritas-gate could not parse the hook payload and let this turn through.");
    }
  }

  // The payload's cwd is wherever the session sits, which may be a
  // subdirectory; the config and the ledger belong at the project root.
  const startDir = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : context.fallbackCwd;
  const root = findProjectRoot(startDir);
  const sessionId = typeof payload.session_id === "string" && payload.session_id !== "" ? payload.session_id : "default";
  const run = context.runner ?? runChecks;

  // --- 2. Unconditional pass-throughs --------------------------------------
  if (isBypassed(context.argv, context.env)) {
    return allow();
  }

  // Claude Code's own loop protection has engaged. Blocking again would either
  // be ignored or fight the platform, so veritas escalates visibly instead.
  const loopProtectionEngaged = payload.loop_protection_blocked === true || payload.stop_hook_active === true;

  const loaded = loadConfig(root);

  if (loaded.config.checks.length === 0) {
    // No configuration, no opinion. Warn once per session at most.
    return allow(
      loaded.warnings.length > 0
        ? `veritas-gate: ${loaded.warnings.join("; ")}`
        : undefined,
    );
  }

  if (loaded.config.dryRun) {
    const results = await run(loaded.config.checks, { cwd: root, env: context.env });
    recordResults(root, results, "hook");

    const failures = results.filter(isBlockingFailure);
    return allow(
      failures.length === 0
        ? "veritas-gate (dry_run): all blocking checks passed."
        : `veritas-gate (dry_run): would have blocked. Failing: ${failures.map((r) => r.name).join(", ")}`,
    );
  }

  const state = readState(root);
  const attemptsSoFar = blocksFor(state, sessionId);

  // --- 3. Escalation --------------------------------------------------------
  if (loopProtectionEngaged || attemptsSoFar >= loaded.config.maxAttempts) {
    const results = await run(loaded.config.checks.filter((check) => check.blocking), {
      cwd: root,
      env: context.env,
      stopOnFirstBlockingFailure: false,
    });
    recordResults(root, results, "hook");

    const failures = results.filter(isBlockingFailure);

    // If everything is green after all, say so plainly and reset.
    if (failures.length === 0) {
      writeState(root, withReset(state, sessionId, fingerprint(root, loaded.config.watch)));
      return allow("veritas-gate: all blocking checks passed.");
    }

    // Deliberately not a reset: see withTouch. Giving up has to stick until the
    // checks pass, otherwise veritas blocks again on the next turn forever.
    writeState(root, withTouch(state, sessionId));
    return allow(formatNotVerified(results, attemptsSoFar, loopProtectionEngaged ? "loop-protection" : "attempts"));
  }

  // --- 4. Change cache ------------------------------------------------------
  const current = fingerprint(root, loaded.config.watch);

  if (current !== null && state.lastGreenFingerprint === current) {
    return allow();
  }

  // --- 5. Run the blocking checks ------------------------------------------
  const blockingChecks = loaded.config.checks.filter((check) => check.blocking);

  if (blockingChecks.length === 0) {
    return allow();
  }

  const results = await run(blockingChecks, {
    cwd: root,
    env: context.env,
    stopOnFirstBlockingFailure: true,
  });

  recordResults(root, results, "hook");

  const failures = results.filter(isBlockingFailure);

  // --- 6. All green ---------------------------------------------------------
  if (failures.length === 0) {
    writeState(root, withReset(state, sessionId, current));

    const infrastructure = results.filter(isInfrastructureProblem);
    return allow(
      infrastructure.length === 0
        ? undefined
        : `veritas-gate: verified, but ${infrastructure.map((r) => r.name).join(", ")} could not run.`,
    );
  }

  // --- 7. At least one red --------------------------------------------------
  const attempt = attemptsSoFar + 1;
  writeState(root, withBlock(state, sessionId));

  return block(
    formatBlockReason(results, attempt, loaded.config.maxAttempts),
    `veritas-gate blocked this turn (attempt ${attempt}/${loaded.config.maxAttempts}): ${failures
      .map((result) => result.name)
      .join(", ")} failing. Set VERITAS_SKIP=1 to bypass.`,
  );
}

/** Exported for tests: a one-line summary of a set of results. */
export function summarize(results: readonly CheckResult[]): string {
  return results.map(formatResultLine).join("\n");
}
