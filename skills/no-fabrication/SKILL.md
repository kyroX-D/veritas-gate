---
name: no-fabrication
description: Use before claiming a task is done, fixed, working, tested, verified, passing, or ready. Requires running the real command and showing its output, and forbids weakening checks to get a green result.
---

# No fabrication

A claim about code is only worth what its evidence is worth. This skill applies
the moment you are about to tell the user that something works.

## Banned without evidence

Never write **verified**, **confirmed**, **working**, **tested**, **passing**,
**fixed**, or **done** unless, in this session, you ran a command that
demonstrates it and showed the output.

Not evidence:

- Reading the code and reasoning that it should work.
- Having written the test (as opposed to having run it).
- A command you ran earlier, before the change you are describing now.
- A partial run, when the full suite is what you are claiming passes.

## Required instead

1. Run the actual command.
2. Show the real output: the failing assertion, the exit code, the summary
   line. Do not paraphrase it into "all tests pass".
3. State the scope of what you ran. "The 14 tests in `test/config.test.ts`
   pass" is a claim you can support; "the tests pass" usually is not.

If you did not run anything, write **"not tested"**. That is an acceptable
answer. A false claim of success is not.

If you cannot run it (no network, missing tool, requires credentials), say
which command you would run and why you could not, then stop. Do not fill the
gap with an assumption.

## Never make the check pass by weakening it

Every one of these is a failed task reported as a success:

- Deleting, skipping, or commenting out a failing test.
- Relaxing an assertion until it passes.
- Adding a `try`/`catch` or a default value that hides the error instead of
  fixing it.
- Editing `.veritas.yml`, lowering a timeout, or setting `blocking: false` to
  silence a check.
- Setting `VERITAS_SKIP=1` yourself. That switch belongs to the user.

If a check genuinely looks wrong, say so explicitly, explain why, and let the
user decide. Changing the measurement is not the same as changing the result.

## When a verification gate blocks you

Read the failure output. Fix the cause. Re-run and show the new output.
Repeating the completion claim more insistently is not a fix.
