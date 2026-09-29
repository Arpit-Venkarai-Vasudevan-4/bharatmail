import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = process.env.PHONEMAIL_SMTP_TEST_TARGET === "phonemail-smtp-demo"
  ? smtpDemoIntegrationTargets()
  : integrationTargets();

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("concurrent idempotent draft sends exceed a two-connection API pool without deadlock or partial commits", async (t) => {
  const phones = [await randomTestPhone(), await randomTestPhone()];
  const createdUsers: string[] = [];
  t.after(async () => {
    if (createdUsers.length) await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [createdUsers]);
  });

  const accounts: { user: { id: string; phone: string; email: string }; token: string }[] = [];
  for (const phone of phones) {
    const result = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    accounts.push(result.body as { user: { id: string; phone: string; email: string }; token: string });
    createdUsers.push(result.body.user.id);
  }
  const [sender, recipient] = accounts;
  const conversation = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [recipient.user.phone] }),
  }, sender.token);
  assert.equal(conversation.response.status, 201, JSON.stringify(conversation.body));
  const draft = await request("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: "Pool concurrency fixture", body: "Atomic local send", to: [recipient.user.email] }),
  }, sender.token);
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  const key = `pool-${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    request(`/api/drafts/${draft.body.draft.id}/send`, {
      method: "POST",
      headers: { "if-match": '"revision-1"', "idempotency-key": key },
      body: JSON.stringify({ conversationId: conversation.body.conversation.id, attachmentIds: [] }),
    }, sender.token),
  ));
  assert.ok(results.every(({ response }) => response.status === 201), JSON.stringify(results.map(({ response, body }) => ({ status: response.status, body }))));
  const messageIds = new Set(results.map(({ body }) => body.message.id));
  assert.equal(messageIds.size, 1);
  const messageId = [...messageIds][0];
  const committed = await query<{ messages: number; deliveries: number; outbox: number; idempotency: number }>(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE id=$1) AS messages,
       (SELECT count(*)::int FROM message_deliveries WHERE message_id=$1) AS deliveries,
       (SELECT count(*)::int FROM outbox_jobs WHERE payload->>'messageId'=$2) AS outbox,
       (SELECT count(*)::int FROM idempotency_keys WHERE user_id=$3 AND idempotency_key=$4) AS idempotency`,
    [messageId, messageId, sender.user.id, key],
  );
  assert.deepEqual(committed.rows[0], { messages: 1, deliveries: 1, outbox: 1, idempotency: 1 });
  assert.equal((await request("/api/me", {}, sender.token)).response.status, 200);
  assert.equal((await request(`/api/drafts/${draft.body.draft.id}`, {}, sender.token)).response.status, 404);
});

test("a first external draft sends without a prior conversation and retries idempotently", async (t) => {
  const phone = await randomTestPhone();
  let userId: string | undefined;
  let messageId: string | undefined;
  t.after(async () => {
    if (messageId) await query("DELETE FROM outbox_jobs WHERE payload->>'messageId'=$1::text", [messageId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
  });

  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  userId = registered.body.user.id;
  const key = `first-draft-${randomUUID()}`;
  const draft = await request("/api/drafts", {
    method: "POST",
    body: JSON.stringify({
      to: [`first-draft-${randomUUID()}@example.test`],
      subject: "First message from a draft",
      body: "No previous conversation is required.",
    }),
  }, registered.body.token);
  assert.equal(draft.response.status, 201, JSON.stringify(draft.body));
  const preSend = await query<{ messages: number; smtp_jobs: number }>(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE sender_user_id=$1) AS messages,
       (SELECT count(*)::int FROM outbox_jobs j JOIN messages m ON m.id=(j.payload->>'messageId')::uuid
         WHERE j.kind='message.smtp-delivery' AND m.sender_user_id=$1) AS smtp_jobs`,
    [userId],
  );
  assert.equal(preSend.rows[0].messages, 0, "saving a draft must not create a message");
  assert.equal(preSend.rows[0].smtp_jobs, 0, "saving a draft must not enqueue SMTP delivery");

  const payload = { attachmentIds: [] };
  const headers = {
    "If-Match": `"revision-${draft.body.draft.revision}"`,
    "Idempotency-Key": key,
  };
  const sent = await request(`/api/drafts/${draft.body.draft.id}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, registered.body.token);
  assert.equal(sent.response.status, 201, JSON.stringify(sent.body));
  messageId = sent.body.message.id;
  assert.equal(typeof sent.body.message.conversationId, "string");
  const retry = await request(`/api/drafts/${draft.body.draft.id}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }, registered.body.token);
  assert.equal(retry.response.status, 201, JSON.stringify(retry.body));
  assert.equal(retry.body.message.id, messageId);

  const committed = await query<{ messages: number; deliveries: number; smtp_jobs: number; idempotency: number }>(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE id=$1 AND lifecycle_status='committed') AS messages,
       (SELECT count(*)::int FROM smtp_message_deliveries WHERE message_id=$1) AS deliveries,
       (SELECT count(*)::int FROM outbox_jobs WHERE kind='message.smtp-delivery' AND payload->>'messageId'=$1::text) AS smtp_jobs,
       (SELECT count(*)::int FROM idempotency_keys WHERE user_id=$2 AND idempotency_key=$3) AS idempotency`,
    [messageId, userId, key],
  );
  assert.deepEqual(committed.rows[0], { messages: 1, deliveries: 1, smtp_jobs: 1, idempotency: 1 });
  const deliveryDeadline = Date.now() + 15_000;
  let relayStatus: string | undefined;
  do {
    const delivery = await query<{ status: string }>(
      "SELECT status FROM smtp_message_deliveries WHERE message_id=$1",
      [messageId],
    );
    relayStatus = delivery.rows[0]?.status;
    if (relayStatus === "relay_accepted") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deliveryDeadline);
  assert.equal(relayStatus, "relay_accepted", "the outbox worker should complete the first draft's SMTP delivery");
  assert.equal((await request(`/api/drafts/${draft.body.draft.id}`, {}, registered.body.token)).response.status, 404);
});
