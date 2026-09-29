import assert from "node:assert/strict";
import test from "node:test";
import { emailFromPhone, normalizePhone, parsePhone, phoneNumberFromPublicIdentity } from "../src/phone";
import { HttpError } from "../src/httpError";

test("phone parsing requires a country for national input and canonicalizes equivalent input", () => {
  assert.equal(normalizePhone("07911 123456", "GB"), "447911123456");
  assert.equal(normalizePhone("+44 7911 123456"), "447911123456");
  assert.equal(normalizePhone("0044 (7911) 123456"), "447911123456");
  assert.equal(normalizePhone("98765-43210", "IN"), "919876543210");
  assert.equal(normalizePhone("9198765432", "IN"), "919198765432");
  assert.throws(() => normalizePhone("07911 123456"), (err: unknown) =>
    err instanceof HttpError && err.code === "PHONE_COUNTRY_REQUIRED");
});

test("phone parsing rejects unsupported countries and numbering-plan mismatches", () => {
  assert.throws(() => parsePhone("07911 123456", "ZZ"), (err: unknown) =>
    err instanceof HttpError && err.code === "PHONE_COUNTRY_INVALID");
  assert.throws(() => parsePhone("12345", "GB"), (err: unknown) =>
    err instanceof HttpError && err.code === "PHONE_INVALID");
  assert.throws(() => parsePhone("+44 98765 43210"), (err: unknown) =>
    err instanceof HttpError && err.code === "PHONE_INVALID");
});

test("public PhoneMail identities retain digit-only local parts", () => {
  assert.equal(phoneNumberFromPublicIdentity("9876543210"), "9876543210");
  assert.equal(emailFromPhone("919876543210", "phonemail.com"), "919876543210@phonemail.com");
  assert.equal(emailFromPhone("+91 98765 43210", "PhoneMail.com"), "919876543210@phonemail.com");
});
