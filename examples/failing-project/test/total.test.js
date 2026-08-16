import { test } from "node:test";
import assert from "node:assert/strict";

import { total } from "../src/total.js";

test("sums every number", () => {
  assert.equal(total([1, 2, 3]), 6);
});

test("an empty list sums to zero", () => {
  assert.equal(total([]), 0);
});
