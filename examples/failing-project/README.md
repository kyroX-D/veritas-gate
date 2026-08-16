# Example: watching veritas-gate block

A tiny project with one deliberately broken function, so you can see the gate
work before you trust it on real code.

`src/total.js` drops the last element of the list. `test/total.test.js` catches
it.

## See it fail

From this directory:

```bash
node ../../dist/veritas.mjs verify
```

You get the failing assertion and exit code 1:

```
[ FAIL ] test - exit 1 ...

NOT VERIFIED: 1 blocking check(s) failed.

--- test: exit code 1 ---
$ npm test
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
3 !== 6
```

## See the hook block

This is what Claude Code sends at the end of a turn. Run it by hand to see the
exact decision veritas returns:

```bash
node -e "process.stdout.write(JSON.stringify({session_id:'demo',cwd:process.cwd(),hook_event_name:'Stop',last_assistant_message:'Fixed it, tests pass.',loop_protection_blocked:false}))" | node ../../dist/veritas.mjs hook
```

The output contains `"decision":"block"` and a `reason` carrying the real
assertion failure. That reason is what the agent sees instead of being allowed
to end its turn.

## See it go green

Fix the bug in `src/total.js`:

```js
for (let i = 0; i < numbers.length; i += 1) {
```

Then run the same two commands. `verify` exits 0, and the hook returns
`"decision":"allow"`.

## See it give up

Leave the bug in place and run the hook command four times. The first three
block; the fourth prints a `NOT VERIFIED - GIVING UP` report and lets the turn
end. veritas escalates visibly rather than nagging forever, and it stays given
up until the checks actually pass.

## See the evidence

```bash
node ../../dist/veritas.mjs status
```

Every run above was appended to `.veritas/ledger.jsonl`.
