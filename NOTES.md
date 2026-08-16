# Research notes (Phase 0)

Facts gathered from the official Claude Code documentation before any implementation.
Everything below is split into **verified** (read directly from the docs listed) and
**NOT verified** (assumption, inference, or missing from the docs).

Docs consulted on 2026-08-16:

- <https://code.claude.com/docs/en/hooks>, the hooks reference
  (`https://docs.claude.com/en/docs/claude-code/hooks` now 301-redirects here)
- <https://code.claude.com/docs/en/plugins-reference>, plugin manifest and layout
- <https://code.claude.com/docs/en/skills>, SKILL.md format

---

## 1. Stop hook input payload (verified)

The `Stop` event fires once per turn, "when Claude finishes responding".
Documented input schema:

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "effort": { "level": "high" },
  "hook_event_name": "Stop",
  "agent_id": "subagent-uuid",
  "agent_type": "agent-name",
  "last_assistant_message": "Claude's final response text",
  "loop_protection_blocked": false
}
```

Relevant details:

- **The loop-protection field is `loop_protection_blocked`** (boolean). The docs
  describe it as indicating "whether Claude's loop protection mechanism blocked
  further iterations".
- `cwd` is the current working directory. This is what veritas uses to locate
  the project root, not `process.cwd()` of the hook process.
- `prompt_id` requires Claude Code v2.1.196+ and is absent until first user input.
- `transcript_path` "may lag the in-memory conversation". veritas does not read it.

> **Correction to the original spec.** The spec assumed a field meaning "the stop
> was already triggered by a hook" (the older `stop_hook_active` name). The
> current documented field is `loop_protection_blocked`. veritas reads
> `loop_protection_blocked` as the primary signal and *also* tolerates a
> `stop_hook_active` boolean if a given Claude Code build still sends it, because
> reading an absent field must never make veritas block.

## 2. How a Stop hook blocks (verified)

Two documented mechanisms:

**a) Exit code 2.** Per the exit-code table, for `Stop`: "Prevents Claude from
stopping; continues the conversation". The blocking reason is the JSON decision
object's `reason` if present, otherwise stderr.

**b) JSON on stdout with exit code 0:**

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "decision": "allow" | "block",
    "reason": "Optional explanation"
  }
}
```

`reason` is "shown to Claude when decision is `block`".

Common output fields available on every event:

| Field | Default | Meaning |
| --- | --- | --- |
| `continue` | `true` | `false` stops Claude entirely; takes precedence over `decision` |
| `stopReason` | — | shown to the *user* when `continue` is false; not shown to Claude |
| `suppressOutput` | `false` | documented as accepted but having **no effect** |
| `systemMessage` | — | warning shown to the user |

Design decision: veritas emits **JSON on stdout and always exits 0**. Reasons:

- The reason text reaches Claude through a documented field rather than stderr.
- Exit code 0 means an unexpected crash (non-zero exit) can never be mistaken for
  a deliberate block. This directly implements the fail-open principle.
- veritas never sets `continue: false`, which would end the session, something far
  more destructive than declining to stop.

## 3. Consecutive-block limit (NOT verified)

The original spec states: "Claude Code limits how often a Stop hook may block
consecutively before the block is ignored" and asks for that number.

**The documentation does not state a numeric limit.** What the docs do provide is
the `loop_protection_blocked` input field, which signals that Claude Code's own
loop protection has already engaged. No threshold, counter, or configuration key
for it appears in the hooks reference.

Consequences for the design, given that veritas does not guess a number:

1. `loop_protection_blocked === true` in the payload is treated as an
   authoritative "stop blocking now" signal: veritas passes through and emits the
   `NOT VERIFIED` escalation report.
2. veritas keeps its **own** consecutive-block counter in its state file and gives
   up at `max_attempts`. The default is **3**, chosen to be conservative rather
   than derived from a documented limit. The point is that veritas escalates
   visibly on its own terms before any silent system-level override could occur.
3. README and `src/hook.ts` both state that this number is a self-imposed
   default, not a documented platform limit.

If someone later finds the real documented number, only `DEFAULT_MAX_ATTEMPTS` in
`src/config.ts` needs to change.

## 4. Plugin packaging (verified)

- Manifest at `.claude-plugin/plugin.json`. Only `name` (kebab-case) is required.
  Optional: `displayName`, `version`, `description`, `author`, `homepage`,
  `repository`, `license`, `keywords`.
- `.claude-plugin/` contains **only** `plugin.json`. `skills/`, `commands/`,
  `hooks/` live at the plugin root. Putting them inside `.claude-plugin/` is
  explicitly documented as wrong.
- Hooks are auto-discovered at `hooks/hooks.json` when the manifest has no `hooks`
  field.
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory.
- Exec form is the documented recommendation for path placeholders:
  `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/check.js"]`.
  veritas uses exactly this shape, which also sidesteps all Windows shell-quoting
  problems.
- Command hook `timeout` defaults to 600 seconds.
- Local development install: `claude --plugin-dir /path/to/plugin-root`
  (session-scoped, nothing written to settings).

## 5. Skills (verified)

- `skills/<name>/SKILL.md`, invoked as `<plugin-name>:<skill-name>`.
- Frontmatter fields used here: `name`, `description`. Both optional in principle;
  `description` is "recommended so Claude knows when to use the skill".
- **The combined `description` + `when_to_use` text is truncated at 1,536
  characters in the skill listing.** This is the concrete budget the spec's
  "keep the description short" instruction refers to.
- `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`,
  `disable-model-invocation`, `user-invocable` also exist; veritas uses none of
  them for the `no-fabrication` skill, which is pure behavioural guidance.

## 6. Slash commands (verified)

- Flat `.md` files under `commands/` become `<plugin-name>:<filename>`.
- Custom commands and skills have been merged: `commands/verify.md` and
  `skills/verify/SKILL.md` are equivalent mechanisms.
- Frontmatter: `description`, `argument-hint`, `allowed-tools`, `model`.
- `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` substitute inside command
  bodies.

Note: the spec asked for `/verify` and `/veritas:status`. Because plugin commands
are always namespaced by plugin name, the actual command names are
`/veritas-gate:verify` and `/veritas-gate:status`. Claude Code allows the short
form when unambiguous.

---

## 7. What a live session confirmed (2026-08-16)

Everything above section 6 came from reading the documentation. This section
comes from watching it run: Windows desktop app, plugin installed by linking the
clone into `~/.claude/skills/veritas-gate`, full app restart.

Confirmed:

- **The skills directory loads a full plugin, not just a skill.** Both slash
  commands and the `no-fabrication` skill appeared as
  `veritas-gate:verify`, `veritas-gate:status`, `veritas-gate:no-fabrication`.
  `/reload-skills` was not enough; hooks needed a restart, which matches the
  documented note that component changes require `/reload-plugins` or a restart.
- **The `Stop` hook fires and its decision is honoured.** A green project
  produced `trigger: hook, status: passed` in the ledger and a stored
  `lastGreenFingerprint`. A red project produced `trigger: hook, status: failed,
  exit_code: 1`, `blocks: 1` in the state file, and `lastGreenFingerprint: null`.
- **The `reason` text reaches the model.** Claude Code presented it under the
  label `Stop hook feedback`, carrying the full block message including the
  assertion and the instruction not to weaken the check.
- **`session_id` is a UUID** and is stable within a session, which is what the
  per-session attempt counter relies on.
- **Escalation holds under real conditions.** One session produced six
  hook-triggered runs against a project that stayed red, and its block count
  rose 1, 2, 3 and then stopped. Three further turns were recorded as runs while
  the counter stayed at 3. The normal path would have reached 6, so the
  escalation branch ran and let those turns through, and the give-up state stuck
  rather than restarting the cycle.
- Cost, for reference: the hook added roughly 16 seconds to one turn in this
  repository (typecheck 2.4s, test 13.7s). The next turn was skipped by the
  change cache.

One inferential step worth flagging: the escalation above is read from
`state.json` and the ledger, not from having seen the `NOT VERIFIED` banner. The
counter behaviour has only one explanation in the code, but that is an inference
rather than a direct observation.

Not confirmed live, and listed in the README as such: the `VERITAS_SKIP` bypass
mid-session, the `claude --plugin-dir` route, and any session on macOS or Linux.

The ledger records `trigger` but not `session_id`, which made reconstructing the
above harder than it needed to be. Adding it would make the audit trail able to
answer "which session was this".

---

## Explicitly NOT verified

| # | Item | Status |
| --- | --- | --- |
| 1 | Numeric limit on consecutive Stop-hook blocks | **Not documented.** Mitigated via `loop_protection_blocked` + self-imposed `max_attempts` (default 3). |
| 2 | Whether `stop_hook_active` is still sent by any current build | Unknown. Read defensively; absence is not an error. |
| 3 | Whether a top-level `decision`/`reason` (outside `hookSpecificOutput`) is still honoured for `Stop` | Unknown. Only the `hookSpecificOutput` shape is documented now. veritas emits **both** shapes; unknown fields are ignored by the parser, so the redundancy is free. |
| 4 | Exact behaviour when several plugins' Stop hooks disagree | Not documented. |
| 5 | Whether hook stdout JSON has a size limit | Not documented. veritas caps `reason` output anyway (last ~50 lines). |

## Design consequences (carried into the implementation)

1. Emit JSON, always exit 0. Non-zero exit is reserved for genuine crashes and is
   harmless because a crashed hook does not block a `Stop`.
2. Wrap the entire hook body in a top-level try/catch that, on any internal error,
   prints an allow-decision plus a `systemMessage` warning. Fail-open.
3. Read the project root from the payload's `cwd`, falling back to
   `process.cwd()`.
4. Never write to stdout except the single JSON object, because any stray logging would
   corrupt the protocol.
