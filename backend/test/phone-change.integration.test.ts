import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();
const secret = process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET ?? "test-secret";
const suffix = randomUUID().slice(0, 8);

async function request(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? "request failed"), { status: response.status, data });
  return data;
}

test("authenticated phone change preserves account identity and revokes old session", async (t) => {
  const oldPhone = await randomTestPhone();
  const newPhone = await randomTestPhone();
  const account = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: oldPhone, password: "StrongPass!123", termsAccepted: true, signupChannel: "web" }),
  });
  const recipient = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  const blocked = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  const conversation = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [recipient.user.phone] }),
  }, account.token);
  const conversationId = conversation.conversation.id;
  const group = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [recipient.user.phone, blocked.user.phone] }),
  }, account.token);
  const groupConversationId = group.conversation.id;
  const groupMessage = await request(`/api/conversations/${groupConversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ subject: "Group continuity", body: "Keep group history" }),
  }, account.token);
  const uploadResponse = await fetch(`${base}/api/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${account.token}`,
      "x-filename": "continuity.txt",
      "x-expected-bytes": "6",
      "x-upload-mode": "resumable",
      "content-type": "application/octet-stream",
    },
    body: "",
  });
  assert.equal(uploadResponse.status, 201);
  const upload = (await uploadResponse.json() as any).upload;
  const chunk = await fetch(`${base}/api/uploads/${upload.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${account.token}`, "x-upload-offset": "0", "content-type": "application/octet-stream" },
    body: "proof!",
  });
  assert.equal(chunk.status, 200);
  const retainedDraft = await request("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: "Unsent continuity", body: "Keep this draft", to: [recipient.user.email] }),
  }, account.token);
  const alias = await request("/api/me/addresses", {
    method: "POST",
    body: JSON.stringify({ alias: `continuity-${randomUUID().slice(0, 8)}` }),
  }, account.token);
  const draft = await request("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: "Continuity", body: "Keep mailbox", to: [recipient.user.email] }),
  }, account.token);
  const sentResponse = await request(`/api/drafts/${draft.draft.id}/send`, {
    method: "POST",
    headers: { "if-match": '"revision-1"', "idempotency-key": `phone-change-${suffix}-send` },
    body: JSON.stringify({ conversationId, attachmentIds: [upload.id] }),
  }, account.token);
  const messageId = sentResponse.message.id;
  const attachmentId = sentResponse.message.attachments[0].id;
  assert.ok(attachmentId);
  await request("/api/me/contacts", {
    method: "POST",
    body: JSON.stringify({ address: recipient.user.email, label: "Continuity contact" }),
  }, account.token);
  await request("/api/me/blocks", { method: "POST", body: JSON.stringify({ userId: blocked.user.id }) }, account.token);
  await request(`/api/conversations/${conversationId}/messages/${messageId}/state`, {
    method: "PATCH",
    body: JSON.stringify({ isRead: true, isFavorite: true, folder: "archive" }),
  }, account.token);
  const recipientDownloadBefore = await fetch(`${base}/api/uploads/${attachmentId}`, {
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  assert.equal(recipientDownloadBefore.status, 200);
  assert.equal(await recipientDownloadBefore.text(), "proof!");
  const challengeId = randomUUID();
  const code = "314159";
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO otp_challenges (id, purpose, phone_normalized, code_hash, expires_at, last_sent_at, provider_request_id, provider)
       VALUES ($1, 'phone_change', $2, $3, now() + interval '5 minutes', now(), $4, 'local_mock')`,
      [challengeId, phoneIdentity(newPhone), createHmac("sha256", secret).update(`${challengeId}:${code}`).digest("hex"), `test-${challengeId}`],
    );
  } finally {
    await client.end();
  }
  const changeKey = `phone-change-${randomUUID()}`;
  const changeBody = { currentPassword: "StrongPass!123", newPhone, challengeId, code };
  const changed = await request("/api/auth/phone-change", {
    method: "POST",
    headers: { "Idempotency-Key": changeKey },
    body: JSON.stringify(changeBody),
  }, account.token);
  assert.equal(changed.user.id, account.user.id);
  assert.equal(changed.user.phone, phoneIdentity(newPhone));
  const phoneChangeAudit = await query<{ count: number; payload: Record<string, unknown> }>(
    `SELECT count(*)::int AS count,(array_agg(payload))[1] AS payload
       FROM account_audit_events WHERE user_id=$1 AND event_type='phone_changed'`,
    [account.user.id],
  );
  assert.equal(phoneChangeAudit.rows[0].count, 1);
  assert.equal("address" in phoneChangeAudit.rows[0].payload, false);
  assert.equal(typeof phoneChangeAudit.rows[0].payload.verificationMethod, "string");
  assert.equal((await query(
    "SELECT 1 FROM security_notifications WHERE user_id=$1 AND event_type='phone_changed'",
    [account.user.id],
  )).rowCount, 1);
  const recovered = await request("/api/auth/phone-change", {
    method: "POST",
    headers: { "Idempotency-Key": changeKey },
    body: JSON.stringify(changeBody),
  }, account.token);
  assert.equal(recovered.token, changed.token);
  assert.deepEqual(recovered.user, changed.user);
  await assert.rejects(
    request("/api/auth/phone-change", {
      method: "POST",
      headers: { "Idempotency-Key": changeKey },
      body: JSON.stringify({ ...changeBody, newPhone: `${newPhone}9` }),
    }, account.token),
    (error: any) => error.status === 409,
  );
  assert.equal((await request("/api/auth/me", {}, changed.token)).user.id, account.user.id);
  const messagesAfterChange = await request(`/api/conversations/${conversationId}/messages`, {}, changed.token);
  assert.ok(messagesAfterChange.messages.some((message: any) => message.id === messageId));
  assert.ok(messagesAfterChange.messages.find((message: any) => message.id === messageId).senderEmail === account.user.email);
  const conversationAfterChange = await request(`/api/conversations/${conversationId}`, {}, changed.token);
  assert.ok(conversationAfterChange.conversation.members.includes(changed.user.email));
  const recipientDownloadAfter = await fetch(`${base}/api/uploads/${attachmentId}`, {
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  assert.equal(recipientDownloadAfter.status, 200);
  assert.equal(await recipientDownloadAfter.text(), "proof!");
  assert.ok((await request("/api/me/contacts", {}, changed.token)).contacts.some((contact: any) => contact.userId === recipient.user.id));
  assert.ok((await request("/api/me/blocks", {}, changed.token)).blocks.some((block: any) => block.userId === blocked.user.id));
  assert.ok((await request("/api/me/addresses", {}, changed.token)).addresses.some((address: any) => address.id === alias.address.id));
  assert.equal((await request(`/api/drafts/${retainedDraft.draft.id}`, {}, changed.token)).draft.body, "Keep this draft");
  assert.ok((await request("/api/conversations/mailbox/archive", {}, changed.token)).messages.some((message: any) => message.id === messageId));
  assert.ok((await request(`/api/conversations/${groupConversationId}/messages`, {}, changed.token)).messages.some((message: any) => message.id === groupMessage.message.id));

  const recipientNewPhone = await randomTestPhone();
  const recipientChallengeId = randomUUID();
  const recipientCode = "672840";
  const recipientClient = new Client({ connectionString: databaseUrl });
  await recipientClient.connect();
  try {
    await recipientClient.query(
      `INSERT INTO otp_challenges (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES ($1,'phone_change',$2,$3,now()+interval '5 minutes',now(),$4,'local_mock')`,
      [recipientChallengeId, phoneIdentity(recipientNewPhone), createHmac("sha256", secret).update(`${recipientChallengeId}:${recipientCode}`).digest("hex"), `test-${recipientChallengeId}`],
    );
  } finally {
    await recipientClient.end();
  }
  const changedRecipient = await request("/api/auth/phone-change", {
    method: "POST",
    body: JSON.stringify({
      currentPassword: "StrongPass!123",
      newPhone: recipientNewPhone,
      challengeId: recipientChallengeId,
      code: recipientCode,
    }),
  }, recipient.token);
  assert.equal(changedRecipient.user.id, recipient.user.id);
  assert.equal(changedRecipient.user.phone, phoneIdentity(recipientNewPhone));
  await assert.rejects(request("/api/auth/me", {}, recipient.token), (error: any) => error.status === 401);
  const recipientConversation = await request(`/api/conversations/${conversationId}/messages`, {}, changedRecipient.token);
  assert.ok(recipientConversation.messages.some((message: any) => message.id === messageId));
  assert.equal(recipientConversation.messages.find((message: any) => message.id === messageId).senderEmail, account.user.email);
  const recipientDownloadAfterBothChanges = await fetch(`${base}/api/uploads/${attachmentId}`, {
    headers: { authorization: `Bearer ${changedRecipient.token}` },
  });
  assert.equal(recipientDownloadAfterBothChanges.status, 200);
  assert.equal(await recipientDownloadAfterBothChanges.text(), "proof!");
  const groupForRecipient = await request(`/api/conversations/${groupConversationId}/messages`, {}, changedRecipient.token);
  assert.ok(groupForRecipient.messages.some((message: any) => message.id === groupMessage.message.id));
  const reopenedDirect = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [recipientNewPhone] }),
  }, changed.token);
  assert.equal(reopenedDirect.conversation.id, conversationId);

  await assert.rejects(request("/api/auth/me", {}, account.token), (error: any) => error.status === 401);
  const replay = await request("/api/auth/phone-change", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "StrongPass!123", newPhone, challengeId, code }),
  }, changed.token).catch((error: any) => error);
  assert.equal(replay.status, 400);
});
