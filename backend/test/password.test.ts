import assert from "node:assert/strict";
import test from "node:test";
import { passwordProvider } from "../src/auth/passwordProvider";

test("passwordProvider hashes and verifies", async () => {
  const hash = await passwordProvider.prepareSecret("secret1");
  assert.ok(hash);
  assert.equal(await passwordProvider.verify(
    { id: "1", phoneNormalized: "9876543210", passwordHash: hash! },
    "secret1"
  ), true);
  assert.equal(await passwordProvider.verify(
    { id: "1", phoneNormalized: "9876543210", passwordHash: hash! },
    "wrong"
  ), false);
});

test("passwordProvider enforces bcrypt's 72-byte limit without truncation", async () => {
  const exactly72Bytes = "🙂".repeat(18);
  assert.equal(Buffer.byteLength(exactly72Bytes, "utf8"), 72);
  const hash = await passwordProvider.prepareSecret(exactly72Bytes);
  assert.ok(hash);
  assert.equal(await passwordProvider.verify(
    { id: "1", phoneNormalized: "9876543210", passwordHash: hash! },
    exactly72Bytes,
  ), true);
  await assert.rejects(() => passwordProvider.prepareSecret(`${exactly72Bytes}x`), /72 UTF-8 bytes/);
});
