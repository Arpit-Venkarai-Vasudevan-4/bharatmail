import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();

async function request(path: string, body: unknown, token: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function waitFor(client: Client, predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("opposite-direction messages use sorted account locks and rollback remains event-lossless", async () => {
  const create = async (phone: string) => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
    });
    return { response, body: await response.json() };
  };
  const a = await create(await randomTestPhone());
  const b = await create(await randomTestPhone());
  assert.equal(a.response.status, 201);
  assert.equal(b.response.status, 201);
  const conversationResponse = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${a.body.token}` },
    body: JSON.stringify({ participantPhones: [b.body.user.phone] }),
  });
  assert.equal(conversationResponse.status, 201);
  const conversationId = (await conversationResponse.json() as any).conversation.id as string;

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const fixture = randomUUID().replace(/-/g, "");
  const functionName = `test_sorted_message_locks_${fixture}`;
  const triggerName = `test_sorted_message_locks_${fixture}`;
  const barrierKey = `phonemail.test.account_lock_barrier:${fixture}`;
  const accountHolder = new Client({ connectionString: databaseUrl });
  const barrierHolder = new Client({ connectionString: databaseUrl });
  let accountTransaction = false;
  let barrierTransaction = false;
  let firstRequest: Promise<{ response: Response; body: any }> | undefined;
  let secondRequest: Promise<{ response: Response; body: any }> | undefined;
  try {
    await accountHolder.connect();
    await barrierHolder.connect();
    await accountHolder.query("BEGIN");
    accountTransaction = true;
    const firstId = [a.body.user.id, b.body.user.id].sort()[0];
    await accountHolder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${firstId}`]);
    await barrierHolder.query("BEGIN");
    barrierTransaction = true;
    await barrierHolder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [barrierKey]);

    await client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.entity_type = 'message' AND NEW.user_id = '${b.body.user.id}'::uuid THEN
          IF EXISTS (SELECT 1 FROM messages WHERE id = NEW.entity_id AND body = 'rollback-marker-${fixture}') THEN
            RAISE EXCEPTION 'intentional isolated message event failure';
          END IF;
          PERFORM pg_advisory_xact_lock(hashtext('${barrierKey}'));
        END IF;
        RETURN NEW;
      END;
    $$`);
    await client.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON account_changes FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

    firstRequest = request(`/api/conversations/${conversationId}/messages`, {
      body: `A-to-B-${fixture}`,
    }, a.body.token);
    secondRequest = request(`/api/conversations/${conversationId}/messages`, {
      body: `B-to-A-${fixture}`,
    }, b.body.token);

    await waitFor(client, async () => {
      const waiting = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory'",
      );
      return waiting.rows[0].count >= 2;
    }, "both opposite-direction requests waiting on the same sorted account lock");
    const beforeRelease = await client.query(
      "SELECT count(*)::int AS count FROM messages WHERE body = ANY($1::text[])",
      [[`A-to-B-${fixture}`, `B-to-A-${fixture}`]],
    );
    assert.equal(beforeRelease.rows[0].count, 0);

    await accountHolder.query("COMMIT");
    accountTransaction = false;
    await waitFor(client, async () => {
      const waiting = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory'",
      );
      return waiting.rows[0].count >= 2;
    }, "first transaction paused at the recipient event barrier while the second waits for the shared account lock");
    await barrierHolder.query("COMMIT");
    barrierTransaction = false;

    const sent = await Promise.all([firstRequest, secondRequest]);
    assert.ok(sent.every((item) => item.response.status === 201), JSON.stringify(sent.map((item) => item.response.status)));
    const messageIds = sent.map((item) => item.body.message.id as string);
    const persisted = await client.query(
      "SELECT id,body FROM messages WHERE id = ANY($1::uuid[]) ORDER BY id",
      [messageIds],
    );
    assert.equal(persisted.rowCount, 2);
    assert.deepEqual(new Set(persisted.rows.map((row) => row.body)), new Set([`A-to-B-${fixture}`, `B-to-A-${fixture}`]));

    for (const account of [a.body.user.id, b.body.user.id]) {
      const events = await client.query(
        "SELECT entity_id FROM account_changes WHERE user_id=$1 AND entity_type='message' AND entity_id=ANY($2::uuid[])",
        [account, messageIds],
      );
      assert.equal(events.rowCount, 2);
    }
    for (const account of [a.body, b.body]) {
      const syncResponse = await fetch(`${base}/api/sync?cursor=0&limit=100`, {
        headers: { authorization: `Bearer ${account.token}` },
      });
      const sync = await syncResponse.json();
      assert.equal(syncResponse.status, 200);
      assert.ok(messageIds.every((id) => sync.changes.some((change: any) => change.entity_id === id)));
    }

    const eventWatermark = await client.query<{ revision: string | null }>(
      "SELECT max(revision)::text AS revision FROM account_changes WHERE user_id = ANY($1::uuid[])",
      [[a.body.user.id, b.body.user.id]],
    );
    const rollback = await request(`/api/conversations/${conversationId}/messages`, {
      body: `rollback-marker-${fixture}`,
    }, a.body.token);
    assert.equal(rollback.response.status, 500);
    const rolledBackMessage = await client.query(
      "SELECT 1 FROM messages WHERE body=$1",
      [`rollback-marker-${fixture}`],
    );
    assert.equal(rolledBackMessage.rowCount, 0);
    const afterRollbackWatermark = await client.query<{ revision: string | null }>(
      "SELECT max(revision)::text AS revision FROM account_changes WHERE user_id = ANY($1::uuid[])",
      [[a.body.user.id, b.body.user.id]],
    );
    assert.equal(afterRollbackWatermark.rows[0].revision, eventWatermark.rows[0].revision);
  } finally {
    if (accountTransaction) await accountHolder.query("ROLLBACK").catch(() => undefined);
    if (barrierTransaction) await barrierHolder.query("ROLLBACK").catch(() => undefined);
    await Promise.allSettled([firstRequest, secondRequest].filter(Boolean) as Promise<unknown>[]);
    await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON account_changes`).catch(() => undefined);
    await client.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
    await Promise.all([accountHolder.end(), barrierHolder.end(), client.end()]);
  }
});
