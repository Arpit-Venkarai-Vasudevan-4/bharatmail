import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";
import { pruneSyncHistory, recordChange, syncChanges } from "../src/services/stage2Service";

const { base, databaseUrl } = integrationTargets();

test("sync retention check and event-page selection serialize against pruning", async () => {
  const suffix = randomUUID().slice(0, 8);
  const registration = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(registration.status, 201);
  const account = await registration.json() as any;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const entityIds = [randomUUID(), randomUUID(), randomUUID()];
  try {
    await client.query("BEGIN");
    for (const id of entityIds) {
      await recordChange(client, account.user.id, "test", id, "upserted", { id });
    }
    await client.query(
      "UPDATE account_changes SET created_at=now()-interval '2 days' WHERE user_id=$1 AND entity_id=ANY($2::uuid[])",
      [account.user.id, entityIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  let signalChecked!: () => void;
  let resume!: () => void;
  const checked = new Promise<void>((resolve) => { signalChecked = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  let pruneFinished = false;
  const syncPromise = syncChanges(account.user.id, "0", 1, async () => {
    signalChecked();
    await held;
  });
  try {
    await checked;
    const prunePromise = pruneSyncHistory(account.user.id, new Date(Date.now() + 1000), 10000)
      .then((result) => {
        pruneFinished = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pruneFinished, false, "pruning must wait until the checked sync page is selected");
    resume();
    const firstPage = await syncPromise;
    assert.equal(firstPage.changes.length, 1);
    assert.equal(firstPage.changes[0].entity_id, entityIds[0]);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.cursor, firstPage.changes[0].revision.toString());
    const pruneResult = await prunePromise;
    assert.equal(pruneResult.removed, 3);
    await assert.rejects(
      syncChanges(account.user.id, firstPage.cursor, 1),
      (error: { code?: string }) => error.code === "CURSOR_EXPIRED",
    );
  } finally {
    resume();
    await syncPromise.catch(() => undefined);
  }
});
