import assert from "node:assert/strict";
import test from "node:test";

import { parseCookieHeader } from "../src/auth/cookies";

test("malformed percent-encoded cookies are ignored without throwing", () => {
  assert.doesNotThrow(() => parseCookieHeader("phonemail_session=%E0%A4%A; phonemail_csrf=ok"));
  assert.equal(parseCookieHeader("phonemail_session=%E0%A4%A")["phonemail_session"], "");
  assert.equal(parseCookieHeader("phonemail_csrf=ok")["phonemail_csrf"], "ok");
});
