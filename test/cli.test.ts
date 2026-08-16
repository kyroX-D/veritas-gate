import { test } from "node:test";
import assert from "node:assert/strict";

import { main, USAGE, VERSION } from "../src/cli.ts";

test("--help exits 0", async () => {
  assert.equal(await main(["--help"]), 0);
});

test("--version exits 0", async () => {
  assert.equal(await main(["--version"]), 0);
});

test("usage mentions every subcommand", () => {
  for (const command of ["init", "verify", "status", "hook"]) {
    assert.ok(USAGE.includes(command), `usage should mention ${command}`);
  }
});

test("unknown commands fail loudly instead of silently succeeding", async () => {
  await assert.rejects(() => main(["nope"]), /unknown command: nope/);
});

test("version is a semver string", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
