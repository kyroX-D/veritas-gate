// The status table. The ledger is the evidence; this is how a human reads it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatStatus } from "../src/format.ts";
import type { LedgerEntry } from "../src/ledger.ts";

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  timestamp: "2026-08-17T00:10:06.198Z",
  trigger: "hook",
  check: "test",
  command: "npm test",
  status: "passed",
  exit_code: 0,
  duration_ms: 1234,
  blocking: true,
  output: "",
  git_commit: "135d57ed1d2956626e4c27589372fff97aff05d4",
  session_id: null,
  ...overrides,
});

test("the session column shows enough of the id to tell sessions apart", () => {
  const table = formatStatus(
    [
      entry({ session_id: "550e8400-e29b-41d4-a716-446655440000" }),
      entry({ check: "typecheck", session_id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
    ],
    "/project",
  );

  assert.match(table, /550e8400/);
  assert.match(table, /6ba7b810/);
  assert.doesNotMatch(table, /446655440000/, "the full uuid would push the row past a sane width");
});

test("a window with no session ids gets no session column", () => {
  const table = formatStatus([entry({ trigger: "manual" }), entry({ trigger: "manual", check: "build" })], "/project");

  for (const line of table.split("\n")) {
    assert.doesNotMatch(line, /\s-\s*$/, `a manual-only table should not trail dashes: ${line}`);
  }
});

test("entries written before session_id existed still render", () => {
  // Exactly the shape of a line already sitting in someone's ledger: the field
  // is absent, not null. Reading it back must not produce "undefined" in a row.
  const legacy: Record<string, unknown> = { ...entry() };
  delete legacy["session_id"];

  const table = formatStatus([legacy as unknown as LedgerEntry, entry({ session_id: "abcdef12-3456" })], "/project");

  assert.doesNotMatch(table, /undefined/);
  assert.match(table, /abcdef12/);
  assert.match(table, /\s-$/m, "the older run is marked as having no session");
});

test("an empty ledger says so and names the file", () => {
  const table = formatStatus([], "/project");

  assert.match(table, /No runs recorded yet/);
  assert.match(table, /ledger\.jsonl/);
});
