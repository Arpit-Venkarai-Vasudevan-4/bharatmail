import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/phonemail_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "outbox-worker-unit-test-secret";
process.env.NODE_ENV = "development";
const { startOutboxWorker } = require("../src/outboxWorker") as typeof import("../src/outboxWorker");

test("outbox shutdown waits for an active bounded tick", async () => {
  let started!: () => void;
  let finish!: () => void;
  const tickStarted = new Promise<void>((resolve) => { started = resolve; });
  const inFlight = new Promise<void>((resolve) => { finish = resolve; });
  const stop = startOutboxWorker({
    intervalMs: 60_000,
    handler: async () => {},
    processBatch: async () => {
      started();
      await inFlight;
      return { claimed: 1, sent: 1, failed: 0 };
    },
  });
  await tickStarted;
  const drained = stop(1_000);
  finish();
  assert.equal(await drained, true);
});

test("outbox shutdown reports a timeout without acknowledging an unfinished tick", async () => {
  let started!: () => void;
  let finish!: () => void;
  const tickStarted = new Promise<void>((resolve) => { started = resolve; });
  const inFlight = new Promise<void>((resolve) => { finish = resolve; });
  const stop = startOutboxWorker({
    intervalMs: 60_000,
    handler: async () => {},
    processBatch: async () => {
      started();
      await inFlight;
      return { claimed: 1, sent: 1, failed: 0 };
    },
  });
  await tickStarted;
  assert.equal(await stop(10), false);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await stop(1_000), true);
});
