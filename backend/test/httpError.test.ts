import assert from "node:assert/strict";
import test from "node:test";
import { isDependencyUnavailableError } from "../src/httpError";

test("database connection failures are recognized without exposing error text", () => {
  for (const code of ["ECONNREFUSED", "57P01", "08006", "53300"]) {
    assert.equal(isDependencyUnavailableError(Object.assign(new Error("sensitive connection text"), { code })), true);
  }
  assert.equal(isDependencyUnavailableError(Object.assign(new Error("bad password"), { code: "28P01" })), false);
  assert.equal(isDependencyUnavailableError(new Error("connection refused")), false);
  assert.equal(isDependencyUnavailableError(null), false);
});
