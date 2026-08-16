# Recording the demo

`scripts/demo.mjs` drives the real bundled binary against a throwaway project
and prints the whole arc: the agent's claim, the block with the actual failing
assertion, the fix, the allow, and the ledger. It cleans up after itself.

```bash
node scripts/demo.mjs
```

For recording, `--slow` inserts pauses so the steps are readable:

```bash
node scripts/demo.mjs --slow
```

Nothing in the output is staged. Every line under a prompt is what the command
returned, which is the only kind of demo this project has any business shipping.

## Recording it

[asciinema](https://asciinema.org) gives the smallest, sharpest result, and the
recording stays selectable text rather than becoming pixels.

```bash
asciinema rec veritas-demo.cast --command "node scripts/demo.mjs --slow"
```

Convert to a GIF for embedding with [agg](https://github.com/asciinema/agg):

```bash
agg --theme monokai --font-size 16 veritas-demo.cast docs/demo.gif
```

On Windows, [Terminalizer](https://github.com/faressoft/terminalizer) and
[ScreenToGif](https://www.screentogif.com) both work.

## What to check before you publish it

- Under 30 seconds. Past that people scrub away.
- The assertion line (`3 !== 6`) must be legible at the size X and Reddit render
  inline, which is smaller than you think. Test it on a phone.
- No absolute paths from your machine in frame.
- Terminal at roughly 90 columns. Wider gets shrunk into illegibility.

## Embedding

Put the result at `docs/demo.gif` and add it to the README directly under the
badges:

```markdown
![veritas-gate blocking a turn whose tests fail](docs/demo.gif)
```

Keep the alt text descriptive. It is what screen readers get, and it is what
Google indexes.

## A note on what this demo does not show

The transcript shows a Stop-hook payload going in and a decision coming out,
which is exactly what Claude Code sends and receives. It does not show Claude
Code itself driving that exchange, because the demo runs the binary directly.

Once you have watched the plugin block a real session, a screen recording of
that is the stronger asset. Use this one until then, and do not describe it as
something it isn't.
