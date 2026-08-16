# Contributing

## Setup

```bash
npm install
```

Node 22.18 or newer is required for development. The test suite runs the
TypeScript sources directly through Node's native type stripping, so there is no
transpile step and no test-time transpiler dependency. The published bundle
targets Node 20.

## The three commands

```bash
npm run typecheck && npm test && npm run build
```

`npm run build` regenerates `dist/veritas.mjs`. **The bundle is committed**, so
that the plugin works without an install step. Any change under `src/` must be
accompanied by a rebuilt bundle in the same commit, or the plugin ships stale
behaviour. A packaging test asserts the bundle exists and behaves, but it cannot
tell you the bundle is out of date — rebuild before committing.

## Constraints that are not up for negotiation

These follow from what the tool is for. A pull request that breaks one of them
will not be merged, however good the idea is otherwise.

- **Zero runtime dependencies.** `package.json` has no `dependencies` block and
  should not grow one. The YAML subset parser in `src/yaml.ts` exists for this
  reason. Dev dependencies are limited to TypeScript and esbuild.
- **Fail open.** Any internal error — unreadable config, crashing runner,
  unwritable state — must let the turn through with a warning. `handleHook`
  never throws and never exits non-zero. If you add a code path that can throw,
  add the test that proves it still allows.
- **Never block on a false positive.** A missing tool, a spawn error, an
  unparseable config: none of these may block. Only a check that ran and
  reported failure.
- **The bypass always works.** `VERITAS_SKIP=1` and `--skip` must short-circuit
  before anything else can go wrong.
- **No network access, no telemetry**, ever.
- **Cross-platform.** No hardcoded POSIX paths, no assuming a shell builtin
  exists. Use `node:path`. Windows is a first-class target, and it is where most
  of the interesting bugs have been.
- **No placeholder implementations.** A function that is not finished must throw
  when called, not return a plausible-looking value.

## Testing

```bash
npm test
```

Tests live in `test/*.test.ts` and use `node:test` with `node:assert/strict`.

The hook handler is a pure function from a JSON string to an object, which is
what makes the decision tree testable without a running Claude Code instance.
Add fixtures to `test/hook.test.ts` rather than reaching for mocks. `HookContext`
carries an optional `runner` seam for the cases where you need to simulate the
runner itself failing.

Two things worth knowing before you write a test:

- Do not pass a bare `{}` as the environment. Stripping `PATH` makes every check
  look like a missing tool rather than a failure. Use the `baseEnv()` helper.
- Shell error messages are localised. Do not assert on them, and do not add
  detection logic that matches them; `programExists` resolves `PATH` instead,
  precisely because a German Windows reports a missing command in German.
- If a test spawns veritas and the check under test runs `node --test`, strip
  `NODE_TEST_CONTEXT` from the child environment (`cleanEnv()` in
  `test/plugin.test.ts`). Node's test runner exports it to children, and an
  inner `node --test` that sees it switches to child-reporter mode and exits 0
  even when its tests fail. That silently turns a "this must block" test into a
  passing one.
- Tests must not run inside `examples/`. Copy the example to a temp directory
  first, or a leftover `.veritas/state.json` from a previous run will decide the
  outcome instead of the code.

## Documentation about the hook API

`NOTES.md` records what was verified against the Claude Code documentation, with
links, and — just as importantly — what could not be verified. If you learn
something new about the hook protocol, update `NOTES.md` with the source. If you
find the documented consecutive-block limit that section 3 says does not exist,
that is the single most useful contribution available.

Do not invent field names. If you are unsure of a payload field, check the docs
or leave it out.

## Commits

Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

Describe what changed and why. If a test caught a real bug, say what the bug
was — those messages are the project's memory.
