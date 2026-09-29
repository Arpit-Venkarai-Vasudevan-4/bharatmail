import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query } from "../src/db";
import { twilioSignature } from "../src/notifications/twilio";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const publicUrl = process.env.TWILIO_PUBLIC_URL;

if (!accountSid || !authToken || !publicUrl) {
  throw new Error("Worker integration requires the isolated signed-callback fixture environment");
}

async function response(path: string, init: RequestInit = {}, token?: string) {
  const result = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = result.status === 204 ? null : await result.json();
  return { response: result, body };
}

test("enabled outbox worker processes a local notification without external delivery", async (t) => {
  let senderId: string | undefined;
  let recipientId: string | undefined;
  let messageId: string | undefined;
  const recipientPhone = await randomTestPhone();
  const senderPhone = await randomTestPhone();

  t.after(async () => {
    if (messageId) {
      await query("DELETE FROM outbox_jobs WHERE payload->>'messageId'=$1", [messageId]);
    }
    if (senderId) await query("DELETE FROM users WHERE id=$1", [senderId]);
    if (recipientId) await query("DELETE FROM users WHERE id=$1", [recipientId]);
  });

  const fields = {
    AccountSid: accountSid,
    To: "+447911123456",
    From: recipientPhone,
    MessageSid: `SM${randomUUID().replace(/-/g, "")}`,
    Body: "JOIN YES",
  };
  const callbackUrl = `${publicUrl}/api/telecom/sms/inbound`;
  const callback = await fetch(`${base}/api/telecom/sms/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(authToken, callbackUrl, fields),
    },
    body: new URLSearchParams(fields),
  });
  assert.equal(callback.status, 200, await callback.text());

  const recipient = await query<{ id: string; phone_verified_at: Date | null }>(
    "SELECT id,phone_verified_at FROM users WHERE phone_normalized=$1",
    [phoneIdentity(recipientPhone)],
  );
  assert.equal(recipient.rowCount, 1);
  assert.ok(recipient.rows[0].phone_verified_at);
  recipientId = recipient.rows[0].id;

  const sender = await response("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      phone: senderPhone,
      password: "StrongPass!123",
      displayName: "Worker fixture sender",
      termsAccepted: true,
    }),
  });
  assert.equal(sender.response.status, 201, JSON.stringify(sender.body));
  senderId = sender.body.user.id;

  const conversation = await response("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [recipientPhone] }),
  }, sender.body.token);
  assert.equal(conversation.response.status, 201, JSON.stringify(conversation.body));

  const sent = await response(`/api/conversations/${conversation.body.conversation.id}/messages`, {
    method: "POST",
    body: JSON.stringify({ subject: "Worker fixture", body: "This body must not be sent by SMS." }),
  }, sender.body.token);
  assert.equal(sent.response.status, 201, JSON.stringify(sent.body));
  messageId = sent.body.message.id;

  await query(
    `UPDATE outbox_jobs SET available_at=to_timestamp(0)
      WHERE kind='message.notification' AND payload->>'messageId'=$1 AND status='queued'`,
    [messageId],
  );

  const deadline = Date.now() + 15_000;
  let delivery: { status: string } | undefined;
  let job: { status: string; attempts: number } | undefined;
  while (Date.now() < deadline) {
    const result = await query<{ delivery_status: string | null; job_status: string | null; attempts: number | null }>(
      `SELECT d.status AS delivery_status,j.status AS job_status,j.attempts
         FROM outbox_jobs j
         LEFT JOIN notification_deliveries d
           ON d.message_id=(j.payload->>'messageId')::uuid AND d.recipient_user_id=$2
        WHERE j.kind='message.notification' AND j.payload->>'messageId'=$1`,
      [messageId, recipientId],
    );
    delivery = result.rows[0]?.delivery_status ? { status: result.rows[0].delivery_status } : undefined;
    job = result.rows[0]?.job_status
      ? { status: result.rows[0].job_status, attempts: result.rows[0].attempts ?? 0 }
      : undefined;
    if (delivery?.status === "simulated" && job?.status === "sent") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.deepEqual(delivery, { status: "simulated" });
  assert.equal(job?.status, "sent");
  assert.equal(job?.attempts, 1);
});
