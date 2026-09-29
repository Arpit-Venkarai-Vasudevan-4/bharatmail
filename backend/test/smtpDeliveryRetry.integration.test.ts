import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { processClaimedOutbox } from "../src/outboxWorker";
import { query } from "../src/db";
import { processSmtpDelivery } from "../src/services/smtpService";
import type { MailTransport, OutgoingMail } from "../src/transport";
import type { OutboxJob } from "../src/outbox";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = smtpDemoIntegrationTargets();

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("outbox retries only temporary SMTP recipients and preserves per-recipient attempt counts", async (t) => {
  const phone = await randomTestPhone();
  const fixtureId = randomUUID().replace(/-/g, "");
  const functionName = `smtp_retry_fn_${fixtureId}`;
  const triggerName = `smtp_retry_trg_${fixtureId}`;
  const firstLeaseToken = randomUUID();
  const firstRecipient = "accepted@example.test";
  const temporaryRecipient = "temporary@example.test";
  const permanentRecipient = "permanent@example.test";
  let userId: string | undefined;
  let outboxId: string | undefined;
  let triggerCreated = false;
  let functionCreated = false;

  t.after(async () => {
    if (triggerCreated) await query(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_jobs`);
    if (functionCreated) await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    if (outboxId) await query("DELETE FROM outbox_jobs WHERE id=$1", [outboxId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
  });

  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
  userId = registered.body.user.id;
  await query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='message.smtp-delivery' AND EXISTS (
        SELECT 1 FROM messages m
         WHERE m.id=(NEW.payload->>'messageId')::uuid
           AND m.sender_user_id='${userId}'::uuid
      ) THEN
        NEW.status='leased';
        NEW.attempts=1;
        NEW.lease_until=now()+interval '1 day';
        NEW.lease_token='${firstLeaseToken}'::uuid;
      END IF;
      RETURN NEW;
    END;
    $$`);
  functionCreated = true;
  await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  triggerCreated = true;

  const composed = await request("/api/mail/compose", {
    method: "POST",
    headers: { "Idempotency-Key": `smtp-mixed-${fixtureId}` },
    body: JSON.stringify({
      to: [firstRecipient, temporaryRecipient],
      cc: [permanentRecipient],
      subject: `Mixed SMTP ${fixtureId}`,
      body: "Recipient-specific retry fixture",
    }),
  }, registered.body.token);
  assert.equal(composed.response.status, 201, JSON.stringify(composed.body));
  const messageId = composed.body.message.id as string;
  const queued = await query<{ id: string; kind: string; payload: { messageId: string }; lease_token: string }>(
    `SELECT id,kind,payload,lease_token::text
       FROM outbox_jobs WHERE kind='message.smtp-delivery' AND payload->>'messageId'=$1::text`,
    [messageId],
  );
  assert.equal(queued.rows.length, 1);
  outboxId = queued.rows[0].id;
  assert.equal(queued.rows[0].lease_token, firstLeaseToken);

  const calls: OutgoingMail[] = [];
  const transport: MailTransport = {
    async send(message) {
      calls.push(message);
      if (calls.length === 1) {
        return {
          messageId: message.messageId,
          accepted: [firstRecipient],
          rejected: [temporaryRecipient, permanentRecipient],
          rejectedDetails: [
            { address: temporaryRecipient, code: 450, message: "Mailbox busy" },
            { address: permanentRecipient, code: 550, message: "Recipient unavailable" },
          ],
          response: "250 2.0.0 mixed recipient response",
        };
      }
      return {
        messageId: message.messageId,
        accepted: [temporaryRecipient],
        rejected: [],
        rejectedDetails: [],
        response: "250 2.0.0 accepted",
      };
    },
    async close() {},
  };
  const handler = async (job: OutboxJob) => {
    const payload = job.payload as { messageId: string };
    await processSmtpDelivery(payload.messageId, transport);
  };
  const firstJob: OutboxJob = { ...queued.rows[0], leaseToken: queued.rows[0].lease_token };
  const firstBatch = await processClaimedOutbox([firstJob], handler);
  assert.deepEqual(firstBatch, { claimed: 1, sent: 0, failed: 1 });
  assert.deepEqual(calls[0].envelope?.to, [firstRecipient, temporaryRecipient, permanentRecipient].sort());

  const afterFirst = await query<{
    recipient_email: string;
    status: string;
    attempts: number;
  }>(
    "SELECT recipient_email,status,attempts FROM smtp_message_deliveries WHERE message_id=$1 ORDER BY recipient_email",
    [messageId],
  );
  assert.deepEqual(afterFirst.rows, [
    { recipient_email: firstRecipient, status: "relay_accepted", attempts: 1 },
    { recipient_email: permanentRecipient, status: "failed", attempts: 1 },
    { recipient_email: temporaryRecipient, status: "retrying", attempts: 1 },
  ]);
  const requeued = await query<{ status: string; attempts: number }>(
    "SELECT status,attempts FROM outbox_jobs WHERE id=$1",
    [outboxId],
  );
  assert.deepEqual(requeued.rows[0], { status: "queued", attempts: 1 });

  const secondLeaseToken = randomUUID();
  const secondClaim = await query<{ id: string; kind: string; payload: { messageId: string } }>(
    `UPDATE outbox_jobs
        SET status='leased',attempts=attempts+1,available_at=now(),
            lease_until=now()+interval '1 day',lease_token=$2
      WHERE id=$1 AND status='queued'
      RETURNING id,kind,payload`,
    [outboxId, secondLeaseToken],
  );
  assert.equal(secondClaim.rows.length, 1, "temporary rejection must leave the SMTP outbox job retryable");
  const secondBatch = await processClaimedOutbox(
    [{ ...secondClaim.rows[0], leaseToken: secondLeaseToken }],
    handler,
  );
  assert.deepEqual(secondBatch, { claimed: 1, sent: 1, failed: 0 });
  assert.deepEqual(calls[1].envelope?.to, [temporaryRecipient],
    "the accepted and permanently rejected recipients must not be resent");
  assert.deepEqual([...calls[1].to].sort(), [firstRecipient, temporaryRecipient].sort(),
    "retry retains the original To header while narrowing the SMTP envelope");
  assert.deepEqual(calls[1].cc, [permanentRecipient]);

  const finalDeliveries = await query<{
    recipient_email: string;
    status: string;
    attempts: number;
  }>(
    "SELECT recipient_email,status,attempts FROM smtp_message_deliveries WHERE message_id=$1 ORDER BY recipient_email",
    [messageId],
  );
  assert.deepEqual(finalDeliveries.rows, [
    { recipient_email: firstRecipient, status: "relay_accepted", attempts: 1 },
    { recipient_email: permanentRecipient, status: "failed", attempts: 1 },
    { recipient_email: temporaryRecipient, status: "relay_accepted", attempts: 2 },
  ]);
  const completedJob = await query<{ status: string; attempts: number }>(
    "SELECT status,attempts FROM outbox_jobs WHERE id=$1",
    [outboxId],
  );
  assert.deepEqual(completedJob.rows[0], { status: "sent", attempts: 2 });
  console.log("PASS actual outbox retry for only the temporary SMTP recipient");
});
