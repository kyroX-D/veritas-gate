# veritas-gate

**Your agent doesn't get to say "done" without proof.**

A Claude Code plugin that runs your tests, typecheck and lint before the agent
is allowed to end its turn — and blocks with the real failure output when
something is red.

## The problem

Coding agents report completion they have not demonstrated. "I've fixed the bug
and the tests pass" arrives without a test run behind it. The failure mode is
not that the agent lies on purpose; it is that nothing in the loop forces the
claim to be checked before it reaches you.

veritas-gate closes that loop. A `Stop` hook intercepts the end of every turn,
runs the checks you configured, and refuses to let the turn end while a blocking
check is failing. The block carries the actual command output, so the agent gets
the failing assertion rather than a scolding.

## Install

```bash
git clone https://github.com/YOUR-USERNAME/veritas-gate
```

```bash
claude --plugin-dir /path/to/veritas-gate
```

The bundle in `dist/` is committed, so there is no build or install step. Then,
in your project:

```bash
node /path/to/veritas-gate/dist/veritas.mjs init
```

That writes a `.veritas.yml` based on what it finds. Review it and you are done.

Without a `.veritas.yml`, veritas auto-detects Node, Python, Rust and Go
projects. If it recognises nothing, it runs in no-op mode and never blocks.

## Bypass

There is always a visible way out.

```bash
VERITAS_SKIP=1 claude
```

Set `VERITAS_SKIP=1` in the environment and every check is skipped, everywhere —
the hook, `verify`, all of it. The `--skip` flag does the same for a single
command:

```bash
node /path/to/veritas-gate/dist/veritas.mjs verify --skip
```

To keep veritas reporting without ever blocking, set `dry_run: true` in
`.veritas.yml`.

## Commands

| Command | What it does |
| --- | --- |
| `veritas init` | Detect the project and write `.veritas.yml` |
| `veritas verify` | Run the checks now; exit 1 if a blocking check fails |
| `veritas status` | Show recent runs from the evidence ledger |
| `veritas hook` | Stop-hook handler; reads hook JSON on stdin |

Inside Claude Code the same things are available as `/veritas-gate:verify` and
`/veritas-gate:status`.

## Configuration

`.veritas.yml` in the project root. Full reference in
[`.veritas.example.yml`](.veritas.example.yml).

```yaml
version: 1

checks:
  - name: typecheck
    run: npm run typecheck
    timeout: 120        # seconds
    blocking: true
  - name: test
    run: npm test
    timeout: 300
    blocking: true
  - name: lint
    run: npm run lint
    timeout: 60
    blocking: false     # reports, does not block

max_attempts: 3

watch:
  - "src/**"
  - "test/**"

dry_run: false
```

| Key | Default | Meaning |
| --- | --- | --- |
| `checks[].name` | `check-N` | Label used in reports and the ledger |
| `checks[].run` | — | Required. The shell command to run |
| `checks[].timeout` | `120` | Seconds before the process tree is killed |
| `checks[].blocking` | `true` | Whether a failure may block a turn |
| `max_attempts` | `3` | Consecutive blocks before veritas gives up visibly |
| `watch` | `[]` | Globs; skip checks when nothing matching changed |
| `dry_run` | `false` | Report everything, block nothing |

An invalid config never blocks. veritas warns with the exact field name and
falls back to the default for that field.

## How the gate behaves

1. `VERITAS_SKIP=1`, `--skip`, `dry_run: true`, or no configured checks — pass
   through immediately.
2. If Claude Code's loop protection has already engaged
   (`loop_protection_blocked`), escalate instead of blocking.
3. If veritas has already blocked `max_attempts` times this session, print a
   `NOT VERIFIED` report and let the turn end. It never gives up silently, and
   once it has given up it stays given up until the checks pass.
4. If nothing matching `watch` changed since the last green run, pass through.
5. Otherwise run the blocking checks, stopping at the first failure.
6. All green — reset the counter, record success, pass through.
7. Anything red — record it and block, with the check name, exit code and the
   last ~50 lines of real output.

## Evidence ledger

Every run is appended to `.veritas/ledger.jsonl`:

```json
{"timestamp":"2026-08-16T08:44:11.859Z","trigger":"hook","check":"test","command":"npm test","status":"failed","exit_code":1,"duration_ms":755,"blocking":true,"output":"AssertionError: expected 3 to equal 4","git_commit":"a1b2c3d"}
```

`.veritas/` makes itself git-ignored, so nothing is added to your own
`.gitignore`.

## Limitations

Written honestly, because a verification tool that oversells itself is
self-defeating.

- **The consecutive-block limit is not documented.** The Claude Code hooks
  reference states no maximum number of times a `Stop` hook may block in a row.
  It exposes a `loop_protection_blocked` payload flag instead. veritas honours
  that flag and additionally caps itself at `max_attempts` (default 3), chosen
  conservatively rather than derived from a published number. See
  [`NOTES.md`](NOTES.md) section 3.
- **veritas gates claims, not correctness.** Passing tests mean the tests
  passed. If your suite does not cover the change, veritas will happily let a
  broken change through.
- **It is not a CI replacement.** It runs on your machine, with your
  environment, on whatever the working tree currently contains.
- **A missing tool is treated as "not run", not as a failure.** If `pytest` is
  not installed, that check reports `[ n/a ]` and never blocks. This is
  deliberate — blocking because a tool is absent is the false positive that gets
  a tool uninstalled — but it does mean an uninstalled linter silently stops
  gating.
- **The change cache trusts file size and mtime**, not content hashes. Touching
  a file without changing it re-runs the checks. That is the safe direction, but
  it is not free.
- **If `.veritas/state.json` cannot be written**, the attempt counter cannot
  advance, so veritas would keep blocking up to Claude Code's own loop
  protection rather than escalating at `max_attempts`.
- **A timeout kills the check's process group**, via `taskkill /T` on Windows
  and a process-group signal elsewhere. A check that deliberately detaches a
  grandchild from that group can still outlive the timeout.
- **The YAML parser understands a subset**, not the whole language. Block
  mappings, sequences, quoted and plain scalars and comments are supported;
  anchors, multi-line block scalars and non-empty flow collections are rejected
  with a line number rather than mis-parsed.
- **Not tested against a live Claude Code installation.** The hook protocol is
  implemented against the documented schema and exercised end-to-end via JSON
  fixtures and the real bundled binary, but the `claude` CLI was not available
  on the machine where this was built, so plugin loading itself is unverified.

## Where veritas looks

Commands that read an existing configuration (`verify`, `status`, the hook) walk
up from the current directory to the nearest `.veritas.yml`, falling back to the
nearest git repository. A session sitting in `src/` therefore uses the project's
config and writes one ledger at the project root, rather than scattering
`.veritas/` directories through the tree.

`veritas init` is the exception: it writes where you ran it, because
"initialise here" should mean here.

## No network, no telemetry

veritas makes no network requests and has zero runtime dependencies. Everything
it writes stays in `.veritas/` in your project.

## Development

Requires Node 22.18+ for the test runner, which runs TypeScript directly via
native type stripping.

```bash
npm install && npm run typecheck && npm test && npm run build
```

veritas gates its own development: this repository has a `.veritas.yml`, and CI
runs the suite on Linux, macOS and Windows and fails if the committed `dist/`
bundle does not match `src/`.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
