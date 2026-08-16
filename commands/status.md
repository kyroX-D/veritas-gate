---
description: Show recent verification runs from the veritas evidence ledger
argument-hint: "[number-of-runs]"
allowed-tools: Bash
---

# Verification status

Show the recent check runs recorded in the evidence ledger.

Run this from the project root, passing the user's requested number of runs if
they gave one (default 20):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/veritas.mjs" status --limit 20
```

Report the table as it is. Each row is one recorded check run: timestamp,
trigger (`hook` or `manual`), status, check name, exit code, duration and the
git commit the run happened on.

Point out honestly if the most recent runs are failing, and do not describe the
project as working on the basis of older green rows.
