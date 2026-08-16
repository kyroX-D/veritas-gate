---
description: Run the configured verification checks now and report the real output
allowed-tools: Bash
---

# Verify

Run the project's configured verification checks and report what actually happened.

Run exactly this command from the project root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/veritas.mjs" verify
```

Then report the result under these rules:

- Paste the command's real output. Do not summarise it into a claim of success.
- If the exit code is non-zero, say the work is **not verified** and list which
  checks failed with their exit codes.
- If a check reports `[ n/a ]`, the tool is not installed on this machine. Say
  that plainly instead of treating it as a pass or as a failure.
- Do not modify `.veritas.yml`, weaken a check, or skip a test to get a green
  result. If a check looks wrong, say so and let the user decide.

If the output says veritas is in no-op mode, tell the user to run
`node "${CLAUDE_PLUGIN_ROOT}/dist/veritas.mjs" init` to create a configuration.
