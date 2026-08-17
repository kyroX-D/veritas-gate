```
                    _  _                                    _
__   __  ___  _ __ (_)| |_   __ _  ___         __ _   __ _ | |_   ___
\ \ / / / _ \| '__|| || __| / _` |/ __|  ___  / _` | / _` || __| / _ \
 \ V / |  __/| |   | || |_ | (_| |\__ \ |___|| (_| || (_| || |_ |  __/
  \_/   \___||_|   |_| \__| \__,_||___/       \__, | \__,_| \__| \___|
                                              |___/
                Agents report. veritas-gate verifies.
```

[![CI](https://github.com/kyroX-D/veritas-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/kyroX-D/veritas-gate/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/kyroX-D/veritas-gate?sort=semver)](https://github.com/kyroX-D/veritas-gate/releases)
[![license](https://img.shields.io/github/license/kyroX-D/veritas-gate)](LICENSE)
[![node](https://img.shields.io/badge/node-20.11%2B-brightgreen)](package.json)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)](package.json)

> **AI agents can report that they're done. veritas-gate makes them prove it.**

An AI coding agent finishes a task and tells you the tests pass. Sometimes it
ran them. Sometimes it read the code, decided the change looked right, and
reported success. From the outside those two cases are identical, and you only
find out which one you got after you pull the branch.

veritas-gate is a Claude Code plugin that closes the gap. It intercepts the end
of every turn, runs the checks you configured, and refuses to let the turn
finish while a blocking check is failing. The agent gets the real failing
assertion back, not a warning to try harder.

**Self-reported completion becomes mechanically verified completion.**

## The 30-second version

```
  1. The agent says it is finished.

     "Fixed the bug in total(). All tests pass."

  2. veritas-gate intercepts the end of the turn.

     decision: block

     veritas-gate: the task is NOT verified. Do not report it as complete.

     1 blocking check(s) failed (attempt 1 of 3):

     --- test: exit code 1 ---
     $ npm test
     ...
       AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

       3 !== 6

  3. The agent gets the real assertion back, and fixes the cause.

     -  for (let i = 0; i < numbers.length - 1; i += 1) {
     +  for (let i = 0; i < numbers.length; i += 1) {

  4. Now the turn is allowed to end.

     decision: allow

  5. Both runs are in the ledger, either way.

     $ veritas status
     2026-08-16 15:49:26Z  hook    passed  test  exit    0    915ms
     2026-08-16 15:49:24Z  hook    failed  test  exit    1     1.0s
```

That transcript is not a mockup. Run it yourself:

```bash
node scripts/demo.mjs
```

It builds a throwaway project, drives the real binary, and cleans up after
itself. [`docs/demo.md`](docs/demo.md) covers recording it.

## Install

Two commands, both typed inside Claude Code. No clone, no build step; the
bundle in `dist/` is committed on purpose.

```
/plugin marketplace add kyroX-D/veritas-gate
```

```
/plugin install veritas-gate@veritas
```

If the install summary says `Run /reload-plugins to activate.`, run that.

<details>
<summary>Installing from a clone instead</summary>

```bash
git clone https://github.com/kyroX-D/veritas-gate
```

**Claude desktop app.** Link the clone into your personal skills directory,
where plugins are auto-discovered, then restart the app:

```bash
mklink /J "%USERPROFILE%\.claude\skills\veritas-gate" "C:\path\to\veritas-gate"
```

On macOS and Linux:

```bash
ln -s /path/to/veritas-gate ~/.claude/skills/veritas-gate
```

A restart is required, not `/reload-skills`. That command reloads skills;
hooks and other plugin components need a full restart.

**Claude Code CLI.** One flag, scoped to the session, nothing written to
settings:

```bash
claude --plugin-dir /path/to/veritas-gate
```

</details>

Then, in the project you want gated:

```bash
node /path/to/veritas-gate/dist/veritas.mjs init
```

That reads your project and writes a `.veritas.yml`. Look it over before you
trust it. If you skip `init`, veritas falls back to auto-detection for Node,
Python, Rust and Go. When it recognises nothing, it does nothing.

And the way out, which always works:

```bash
VERITAS_SKIP=1 claude
```

## Why veritas-gate?

Claude Code gives you hooks. veritas-gate gives you a verification system.

The `Stop` hook has shipped for months, and a twenty-line shell script wired to
it will block a turn when your tests fail. That script is the easy 20%. The
table below is the other 80%, and it is the part you would otherwise write once
per project and get subtly wrong each time.

| | A hand-rolled Stop hook | veritas-gate |
| --- | --- | --- |
| Which checks run | hardcoded per project | auto-detected for Node, Python, Rust and Go, overridable in `.veritas.yml` |
| Cost per turn | full suite, every single turn | skipped when no watched file changed since the last green run |
| When it can't be satisfied | blocks until you kill the session | gives up after `max_attempts` with a visible `NOT VERIFIED` report, and stays given up until the checks pass |
| When the hook itself breaks | a crash or a typo can block your session | any internal error fails open with a warning, proven by a test that injects a crashing runner |
| When a tool isn't installed | looks like a failing check, blocks you | reported as "did not run", never blocks |
| What the agent is told | an exit code | the real failing assertion, plus an explicit instruction not to weaken the test to make it green |
| What you can audit later | nothing | append-only JSONL ledger: timestamps, commands, exit codes, durations, commit hashes |
| Agent behaviour | unchanged | a bundled skill that forbids claiming "verified" or "tested" without showing the command output |

None of this is impossible to build yourself. The point is that you would build
it five times, and the fifth one would still fail open in the wrong direction.

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

Two details there matter more than they look.

veritas never gives up quietly. After `max_attempts` consecutive blocks it stops
blocking, but it prints a `NOT VERIFIED` banner on the way out, so a session that
ended unverified never looks like a session that ended clean. Once it has given
up, it stays given up until the checks pass. An earlier version reset its counter
there and produced an endless block-block-block-allow cycle, which is the fastest
way to get a tool uninstalled.

## Use cases

**Long autonomous sessions.** You hand the agent a task and come back in forty
minutes. Without a gate, you audit the whole thing yourself. With one, every
turn that ended is a turn whose checks passed.

**Slow test suites.** The change cache means the suite runs when something
relevant changed, not on every turn. A turn that only edited a Markdown file
costs nothing.

**Polyglot and monorepo work.** Detection covers Node, Python, Rust and Go, and
a session sitting in `packages/api/` walks up to the project's config instead of
using whatever happens to be in the current directory.

**Legacy code where coverage is thin.** veritas will tell you honestly that it
gates claims, not correctness. What it does guarantee is that the suite you do
have actually ran before anyone said "done".

**Teams that need an audit trail.** Every check run lands in
`.veritas/ledger.jsonl` with the commit it ran against, so "it was green on
Tuesday" becomes checkable instead of remembered.

**Anyone who has been burned once.** Which, if you use coding agents daily, is
everyone.

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
{"timestamp":"2026-08-16T13:33:03.225Z","trigger":"manual","check":"test","command":"npm test","status":"failed","exit_code":1,"duration_ms":922,"blocking":true,"output":"3 !== 6","git_commit":null,"session_id":null}
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

The commit column is the state of the tree the run happened on, so a green row
ties back to something specific. It shows dashes when the project isn't a git
repository.

Hook runs also carry the `session_id` from the Stop payload, and `veritas
status` adds a last column with the first characters of it when any run in the
window has one. That is what makes two agents working in the same checkout
tellable apart afterwards. A `veritas verify` you ran yourself belongs to no
session and records `null`.

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
  veritas honours. The `max_attempts` default of 3 is a number chosen to stay
  well clear of trouble, not one read out of the docs. [`NOTES.md`](NOTES.md)
  section 3 has the details.
- It only hooks `Stop`. Claude Code also exposes `TaskCompleted`, which can
  block a task from being marked done. Gating that too is an obvious next step
  and is not implemented yet.
- The live testing behind it is narrow. Loading, gating a green turn, blocking a
  red one and giving up after `max_attempts` have all been observed in real
  sessions, on the Windows desktop app, installed through the skills directory.
  Not yet observed: the `VERITAS_SKIP` bypass mid-session, the
  `claude --plugin-dir` route, and any session on macOS or Linux. Those are
  covered by the test suite and by CI on three platforms, which is evidence but
  not the same evidence.

## No network, no telemetry

veritas makes no network requests and has no runtime dependencies. Everything it
writes stays in `.veritas/` inside your project. The YAML parser is hand-written
for exactly this reason.

## Community

Questions, ideas and "this broke on my setup" reports are all welcome.

- [Discussions](https://github.com/kyroX-D/veritas-gate/discussions) for
  questions, workflows and feature ideas
- [Issues](https://github.com/kyroX-D/veritas-gate/issues) for bugs, with
  your `.veritas.yml` and the output you got
- [Good first issues](https://github.com/kyroX-D/veritas-gate/labels/good%20first%20issue)
  if you want to contribute

The single most useful contribution right now: run it against a real project and
say what broke.

<!-- Social proof. These render as zero until there is something to show, which
     is why they live here rather than at the top of the page. Move them up once
     the numbers argue for you.

[![stars](https://img.shields.io/github/stars/kyroX-D/veritas-gate?style=social)](https://github.com/kyroX-D/veritas-gate/stargazers)
[![forks](https://img.shields.io/github/forks/kyroX-D/veritas-gate?style=social)](https://github.com/kyroX-D/veritas-gate/network/members)
[![contributors](https://img.shields.io/github/contributors/kyroX-D/veritas-gate)](https://github.com/kyroX-D/veritas-gate/graphs/contributors)
-->

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
