import { test } from "node:test";
import assert from "node:assert/strict";

import { main, splitArgv, unknownFlag, USAGE, VERSION, type Io } from "../src/cli.ts";

/** A capturing Io so tests never touch the real streams. */
function io(env: NodeJS.ProcessEnv = {}): Io & { written: string; errors: string } {
  const captured = {
    written: "",
    errors: "",
    stdout: (text: string) => {
      captured.written += text;
    },
    stderr: (text: string) => {
      captured.errors += text;
    },
    env,
    cwd: process.cwd(),
    stdin: async () => "",
  };

  return captured;
}

test("--help exits 0", async () => {
  const captured = io();
  assert.equal(await main(["--help"], captured), 0);
  assert.match(captured.written, /Usage:/);
});

test("no arguments prints usage", async () => {
  const captured = io();
  assert.equal(await main([], captured), 0);
  assert.match(captured.written, /Usage:/);
});

test("--version prints a semver string", async () => {
  const captured = io();
  assert.equal(await main(["--version"], captured), 0);
  assert.equal(captured.written.trim(), VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("usage mentions every subcommand", () => {
  for (const command of ["init", "verify", "status", "hook"]) {
    assert.ok(USAGE.includes(command), `usage should mention ${command}`);
  }
});

test("unknown commands fail loudly instead of silently succeeding", async () => {
  await assert.rejects(() => main(["nope"], io()), /unknown command: nope/);
});

// --- argument handling -----------------------------------------------------

test("splitArgv finds the subcommand after a global flag", () => {
  assert.deepEqual(splitArgv(["-C", "/tmp/x", "verify"]), { command: "verify", args: ["-C", "/tmp/x"] });
  assert.deepEqual(splitArgv(["verify", "-C", "/tmp/x"]), { command: "verify", args: ["-C", "/tmp/x"] });
});

test("splitArgv does not mistake a flag value for the subcommand", () => {
  // Without value-flag awareness, "status" would be read as the command here.
  assert.deepEqual(splitArgv(["--cwd", "status", "verify"]), {
    command: "verify",
    args: ["--cwd", "status"],
  });
});

test("splitArgv reports no command for an empty argv", () => {
  assert.deepEqual(splitArgv([]), { command: undefined, args: [] });
});

test("unknownFlag accepts every documented flag", () => {
  assert.equal(unknownFlag(["--skip"]), undefined);
  assert.equal(unknownFlag(["--force"]), undefined);
  assert.equal(unknownFlag(["--limit", "5"]), undefined);
  assert.equal(unknownFlag(["-C", "/tmp/x", "--skip"]), undefined);
});

test("unknownFlag rejects a typo", () => {
  assert.equal(unknownFlag(["--skpi"]), "--skpi");
  assert.equal(unknownFlag(["--verbose"]), "--verbose");
});

test("unknownFlag does not treat a flag's value as a flag", () => {
  // `--limit -5` must not report "-5" as an unknown option.
  assert.equal(unknownFlag(["--limit", "-5"]), undefined);
});

test("a mistyped bypass flag fails loudly instead of silently not skipping", async () => {
  // Silently ignoring --skpi would look like a bypass that never happened.
  await assert.rejects(() => main(["verify", "--skpi"], io()), /unknown option: --skpi/);
});

test("--help works after a subcommand", async () => {
  const captured = io();
  assert.equal(await main(["verify", "--help"], captured), 0);
  assert.match(captured.written, /Usage:/);
});

test("the usage text documents the bypass", () => {
  assert.match(USAGE, /VERITAS_SKIP=1/);
  assert.match(USAGE, /--skip/);
});
