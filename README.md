```
                    _  _                                    _
__   __  ___  _ __ (_)| |_   __ _  ___         __ _   __ _ | |_   ___
\ \ / / / _ \| '__|| || __| / _` |/ __|  ___  / _` | / _` || __| / _ \
 \ V / |  __/| |   | || |_ | (_| |\__ \ |___|| (_| || (_| || |_ |  __/
  \_/   \___||_|   |_| \__| \__,_||___/       \__, | \__,_| \__| \___|
                                              |___/
      Your agent marks its own homework. veritas-gate grades it.
```

[![CI](https://github.com/YOUR-USERNAME/veritas-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-USERNAME/veritas-gate/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-20.11%2B-brightgreen.svg)](package.json)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](package.json)

A Claude Code plugin that runs your tests before the agent is allowed to finish
its turn. If something is red, the turn does not end.

Claude Code already gives you a Stop hook, so the wiring is there. This is the
part you would otherwise write yourself and keep rewriting: project detection,
a change cache, controlled escalation, fail-open safety, an audit trail, and a
block message that hands the agent the actual failing assertion along with an
explicit instruction not to weaken the test to make it green.

## The problem

You have seen this message:

> I've fixed the bug and all the tests pass.

And you have seen what happens when you run the tests yourself.

The agent usually is not lying. It read the code, the change looked right, and
nothing in the loop ever forced the claim to be checked before it landed in
front of you. Running the tests is the cheapest step to skip and the most
expensive one to have skipped.

veritas-gate puts the check back in the loop. It hooks the moment a turn ends,
runs whatever you configured, and refuses to let the turn finish while a
blocking check is failing.

## What it looks like

When a blocking check fails, this is what the agent receives instead of being
allowed to stop:

```
veritas-gate: the task is NOT verified. Do not report it as complete.

1 blocking check(s) failed (attempt 1 of 3):

--- test: exit code 1 ---
$ npm test
✖ sums every number (4.8643ms)
✔ an empty list sums to zero (1.1317ms)
ℹ tests 2
ℹ pass 1
ℹ fail 1

  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  3 !== 6

Required next steps:
1. Read the output above and fix the underlying cause.
2. Re-run the failing command yourself and paste its real output.
3. Do NOT weaken, skip, delete or rewrite the checks, and do not edit
   .veritas.yml to make them pass. Fixing the check instead of the code is a
   failed task, not a completed one.
```

That transcript comes from [`examples/failing-project`](examples/failing-project),
which ships with a deliberately broken function so you can watch the gate work
before you point it at anything you care about.

Running the same checks by hand, on this repository:

```
$ veritas verify
[ pass ] typecheck 2.0s
[ pass ] test 9.3s
[ pass ] build 780ms (non-blocking)

VERIFIED: all blocking checks passed.
```

## Install

Thirty seconds, no build step. The bundle in `dist/` is committed on purpose.

```bash
git clone https://github.com/YOUR-USERNAME/veritas-gate
```

```bash
claude --plugin-dir /path/to/veritas-gate
```

Then, in the project you want gated:

```bash
node /path/to/veritas-gate/dist/veritas.mjs init
```

That reads your project and writes a `.veritas.yml`. Look it over before you
trust it.

If you skip `init` entirely, veritas falls back to auto-detection for Node,
Python, Rust and Go. When it recognises nothing, it does nothing: no config, no
opinion, no blocking.

## Getting out

Every gate needs a door that opens from the inside.

```bash
VERITAS_SKIP=1 claude
```

That one variable disables everything, everywhere: the hook, `verify`, all of
it. For a single command, `--skip` does the same:

```bash
node /path/to/veritas-gate/dist/veritas.mjs verify --skip
```

And if you want the reports without ever being stopped, put `dry_run: true` in
your config. veritas will run the checks, write them down, and let the turn end
anyway.

## How the gate decides

```
                        Claude finishes a turn
                                  |
                                  v
                   .-------------------------------.
                   |  VERITAS_SKIP, --skip,        |    set
                   |  dry_run, or no checks?       |----------.
                   '-------------------------------'          |
                                  | no                        |
                                  v                           |
                   .-------------------------------.          |
                   |  loop protection engaged, or  |   yes    |
                   |  already blocked max_attempts?|-------.  |
                   '-------------------------------'       |  |
                                  | no                     |  |
                                  v                        v  v
                   .-------------------------------.   .--------------.
                   |  anything in `watch` changed  |   | NOT VERIFIED |
                   |  since the last green run?    |   | report, then |
                   '-------------------------------'   | let it end   |
                          |                 |          '--------------'
                       no |                 | yes
                          |                 v
                          |     .--------------------------.
                          |     |  run the blocking checks  |
                          |     '--------------------------'
                          |            |             |
                          |       all green       any red
                          v            |             |
                    .-----------.      |             v
                    |   allow   |<-----'      .----------------.
                    '-----------'             |      BLOCK     |
                                              |  with the real |
                                              | failure output |
                                              '----------------'
```

Two details in there matter more than they look.

veritas never gives up quietly. After `max_attempts` consecutive blocks it stops
blocking, but it prints a `NOT VERIFIED` banner on the way out, so a session
that ended unverified never looks like a session that ended clean. Once it has
given up, it stays given up until the checks actually pass. An earlier version
reset its counter there and produced an endless block-block-block-allow cycle,
which is the fastest way to get a tool uninstalled.

## Configuration

`.veritas.yml` in the project root. The full reference lives in
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
| `checks[].run` | required | The shell command to run |
| `checks[].timeout` | `120` | Seconds before the process tree is killed |
| `checks[].blocking` | `true` | Whether a failure may block a turn |
| `max_attempts` | `3` | Consecutive blocks before veritas gives up loudly |
| `watch` | `[]` | Globs. Skip the checks when nothing matching changed |
| `dry_run` | `false` | Report everything, block nothing |

A broken config never blocks anything. veritas prints the offending field by
name, falls back to the default for that one field, and carries on.

## Commands

| Command | What it does |
| --- | --- |
| `veritas init` | Read the project, write `.veritas.yml` |
| `veritas verify` | Run the checks now. Exits 1 if a blocking check fails |
| `veritas status` | Recent runs from the evidence ledger |
| `veritas hook` | The Stop-hook handler. Reads hook JSON on stdin |

Inside Claude Code these are `/veritas-gate:verify` and `/veritas-gate:status`.

## The evidence ledger

Claims are cheap. Every run, from the hook or from the CLI, gets appended to
`.veritas/ledger.jsonl`:

```json
{"timestamp":"2026-08-16T13:33:03.225Z","trigger":"manual","check":"test","command":"npm test","status":"failed","exit_code":1,"duration_ms":922,"blocking":true,"output":"3 !== 6","git_commit":null}
```

`veritas status` renders it as a table:

```
$ veritas status
Last 3 run(s) from .veritas/ledger.jsonl:

2026-08-16 13:33:32Z  manual  passed  build      exit    0    780ms  cfe4712
2026-08-16 13:33:32Z  manual  passed  test       exit    0     9.3s  cfe4712
2026-08-16 13:33:32Z  manual  passed  typecheck  exit    0     2.0s  cfe4712

No failures in this window.
```

The last column is the commit the run happened on, so a green row can be tied
back to a specific state of the tree. It shows dashes when the project isn't a
git repository.

The `.veritas/` directory ignores itself, so your own `.gitignore` stays
untouched.

## Where it looks for things

`verify`, `status` and the hook all walk up from the current directory to the
nearest `.veritas.yml`, and fall back to the nearest git repository. A session
sitting in `src/` uses the project's config and writes one ledger at the root,
instead of sprinkling `.veritas/` directories around your tree.

`init` is the exception. It writes where you ran it, because "initialise here"
should mean here.

## What it won't do

A verification tool that oversells itself has a credibility problem. So:

- It gates claims, not correctness. Green tests mean the tests were green. If
  your suite doesn't cover the change, veritas will wave a broken change
  straight through.
- It is not CI. It runs on your machine, in your environment, against whatever
  is in the working tree right now.
- A missing tool counts as "did not run", never as a failure. If `pytest` isn't
  installed, that check reports `[ n/a ]` and blocks nothing. Blocking because a
  tool is absent is exactly the false positive that gets a tool uninstalled, but
  it does mean an uninstalled linter silently stops gating you.
- The change cache compares file size and mtime, not content. Touching a file
  without editing it will re-run the checks. That direction is the safe one, but
  it isn't free.
- If `.veritas/state.json` can't be written, the attempt counter can't advance,
  so veritas would keep blocking until Claude Code's own loop protection steps
  in rather than escalating at `max_attempts`.
- Timeouts kill the check's process group, through `taskkill /T` on Windows and
  a group signal elsewhere. A check that deliberately detaches a grandchild can
  still outlive its timeout.
- The YAML parser handles a subset, not the language. Block mappings, sequences,
  quoted and plain scalars, comments: yes. Anchors, multi-line block scalars and
  non-empty flow collections are rejected with a line number rather than quietly
  mis-parsed.
- The consecutive-block limit is not documented anywhere. Claude Code's hooks
  reference states no maximum number of times a `Stop` hook may block in a row.
  It exposes a `loop_protection_blocked` flag on the payload instead, which
  veritas honours. The `max_attempts` default of 3 is a number I picked to stay
  well clear of trouble, not one I read in the docs. [`NOTES.md`](NOTES.md)
  section 3 has the details.
- Nobody has run this inside a live Claude Code install yet. The hook protocol
  is built against the documented schema and exercised end to end with JSON
  fixtures and the real bundled binary, but the `claude` CLI wasn't available on
  the machine this was written on, so plugin loading itself is unverified. If
  you try it, an issue either way would be genuinely useful.

## No network, no telemetry

veritas makes no network requests and has no runtime dependencies. Everything it
writes stays in `.veritas/` inside your project. The YAML parser is hand-written
for exactly this reason.

## Development

Node 22.18 or newer, because the test suite runs the TypeScript sources directly
through Node's native type stripping. No transpiler, no watch mode, no config.

```bash
npm install && npm run typecheck && npm test && npm run build
```

veritas gates its own development. This repo has a `.veritas.yml`, and CI runs
the suite on Linux, macOS and Windows, then fails the build if the committed
`dist/` bundle no longer matches `src/`.

[CONTRIBUTING.md](CONTRIBUTING.md) covers the constraints that aren't
negotiable, and the two test traps that have already bitten once each.

## License

MIT
