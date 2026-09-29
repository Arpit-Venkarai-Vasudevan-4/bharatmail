import assert from "node:assert/strict";
import test from "node:test";
import { parsePhone } from "../src/phone";
import { createTestPhoneAllocator } from "./testPhone";

test("test phone allocator rejects invalid candidates and returns normalized unique numbers", async () => {
  const candidates = ["+447911999999", "+447911123456", "+447911123456", "+447911000002"];
  const available: string[] = [];
  const allocate = createTestPhoneAllocator({
    candidate: () => candidates.shift() ?? "+447911654321",
    isAvailable: async (e164) => {
      available.push(e164);
      return true;
    },
  });

  const first = await allocate();
  const second = await allocate();
  assert.equal(first, parsePhone("+447911123456").e164);
  assert.equal(second, parsePhone("+447911000002").e164);
  assert.deepEqual(available, [first, second]);
  assert.notEqual(first, second);
});

test("test phone allocator retries retained identities and fails within its configured bound", async () => {
  let attempts = 0;
  const allocate = createTestPhoneAllocator({
    candidate: () => {
      attempts += 1;
      return attempts === 1 ? "+447911123456" : "+447911000002";
    },
    isAvailable: async (_e164, _normalized, address) => address !== "447911123456@phonemail.com",
    maxAttempts: 2,
  });
  assert.equal(await allocate(), "+447911000002");

  const exhausted = createTestPhoneAllocator({
    candidate: () => "+447911999999",
    isAvailable: async () => true,
    maxAttempts: 2,
  });
  await assert.rejects(exhausted(), /after 2 attempts \(invalid=2, duplicate=0, retainedCollision=0\)/);
});
