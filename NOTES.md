# Research notes (Phase 0)

Facts gathered from the official Claude Code documentation before any implementation.
Everything below is split into **verified** (read directly from the docs listed) and
**NOT verified** (assumption, inference, or missing from the docs).

Docs consulted on 2026-08-16:

- <https://code.claude.com/docs/en/hooks> — hooks reference
  (`https://docs.claude.com/en/docs/claude-code/hooks` now 301-redirects here)
- <https://code.claude.com/docs/en/plugins-reference> — plugin manifest & layout
- <https://code.claude.com/docs/en/skills> — SKILL.md format

---

## 1. Stop hook input payload — VERIFIED

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
- `cwd` is the current working directory — this is what veritas uses to locate
  the project root, not `process.cwd()` of the hook process.
- `prompt_id` requires Claude Code v2.1.196+ and is absent until first user input.
- `transcript_path` "may lag the in-memory conversation" — veritas does not read it.

> **Correction to the original spec.** The spec assumed a field meaning "the stop
> was already triggered by a hook" (the older `stop_hook_active` name). The
> current documented field is `loop_protection_blocked`. veritas reads
> `loop_protection_blocked` as the primary signal and *also* tolerates a
> `stop_hook_active` boolean if a given Claude Code build still sends it, because
> reading an absent field must never make veritas block.

## 2. How a Stop hook blocks — VERIFIED

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
- veritas never sets `continue: false` — that would end the session, which is far
  more destructive than declining to stop.

## 3. Consecutive-block limit — **NOT VERIFIED**

The original spec states: "Claude Code limits how often a Stop hook may block
consecutively before the block is ignored" and asks for that number.

**The documentation does not state a numeric limit.** What the docs do provide is
the `loop_protection_blocked` input field, which signals that Claude Code's own
loop protection has already engaged. No threshold, counter, or configuration key
for it appears in the hooks reference.

Consequences for the design — veritas does not guess a number:

1. `loop_protection_blocked === true` in the payload is treated as an
   authoritative "stop blocking now" signal: veritas passes through and emits the
   `NOT VERIFIED` escalation report.
2. veritas keeps its **own** consecutive-block counter in its state file and gives
   up at `max_attempts`. The default is **3**, chosen to be conservative rather
   than derived from a documented limit — the point is that veritas escalates
   visibly on its own terms before any silent system-level override could occur.
3. README and `src/hook.ts` both state that this number is a self-imposed
   default, not a documented platform limit.

If someone later finds the real documented number, only `DEFAULT_MAX_ATTEMPTS` in
`src/config.ts` needs to change.

## 4. Plugin packaging — VERIFIED

- Manifest at `.claude-plugin/plugin.json`. Only `name` (kebab-case) is required.
  Optional: `displayName`, `version`, `description`, `author`, `homepage`,
  `repository`, `license`, `keywords`.
- `.claude-plugin/` contains **only** `plugin.json`. `skills/`, `commands/`,
  `hooks/` live at the plugin root — putting them inside `.claude-plugin/` is
  explicitly documented as wrong.
- Hooks are auto-discovered at `hooks/hooks.json` when the manifest has no `hooks`
  field.
- `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory.
- **Exec form is the documented recommendation for path placeholders:**
  `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/check.js"]`.
  veritas uses exactly this shape, which also sidesteps all Windows shell-quoting
  problems.
- Command hook `timeout` defaults to 600 seconds.
- Local development install: `claude --plugin-dir /path/to/plugin-root`
  (session-scoped, nothing written to settings).

## 5. Skills — VERIFIED

- `skills/<name>/SKILL.md`, invoked as `<plugin-name>:<skill-name>`.
- Frontmatter fields used here: `name`, `description`. Both optional in principle;
  `description` is "recommended so Claude knows when to use the skill".
- **The combined `description` + `when_to_use` text is truncated at 1,536
  characters in the skill listing.** This is the concrete budget the spec's
  "keep the description short" instruction refers to.
- `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`,
  `disable-model-invocation`, `user-invocable` also exist; veritas uses none of
  them for the `no-fabrication` skill, which is pure behavioural guidance.

## 6. Slash commands — VERIFIED

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

## Explicitly NOT verified

| # | Item | Status |
| --- | --- | --- |
| 1 | Numeric limit on consecutive Stop-hook blocks | **Not documented.** Mitigated via `loop_protection_blocked` + self-imposed `max_attempts` (default 3). |
| 2 | Whether `stop_hook_active` is still sent by any current build | Unknown. Read defensively; absence is not an error. |
| 3 | Whether a top-level `decision`/`reason` (outside `hookSpecificOutput`) is still honoured for `Stop` | Unknown — only the `hookSpecificOutput` shape is documented now. veritas emits **both** shapes; unknown fields are ignored by the parser, so the redundancy is free. |
| 4 | Exact behaviour when several plugins' Stop hooks disagree | Not documented. |
| 5 | Whether hook stdout JSON has a size limit | Not documented. veritas caps `reason` output anyway (last ~50 lines). |

## Design consequences (carried into the implementation)

1. Emit JSON, always exit 0. Non-zero exit is reserved for genuine crashes and is
   harmless because a crashed hook does not block a `Stop`.
2. Wrap the entire hook body in a top-level try/catch that, on any internal error,
   prints an allow-decision plus a `systemMessage` warning. Fail-open.
3. Read the project root from the payload's `cwd`, falling back to
   `process.cwd()`.
4. Never write to stdout except the single JSON object — any stray logging would
   corrupt the protocol.
