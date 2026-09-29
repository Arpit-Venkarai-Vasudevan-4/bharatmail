import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, databaseUrl } = process.env.PHONEMAIL_SMTP_TEST_TARGET === "phonemail-smtp-demo"
  ? smtpDemoIntegrationTargets()
  : integrationTargets();
const secretSubject = `private-legacy-draft-subject-${randomUUID()}`;
const secretBody = `private-legacy-draft-body-${randomUUID()}`;
const attachmentBytes = `private-legacy-draft-attachment-bytes-${randomUUID()}`;

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function register(phone: string) {
  const result = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(result.response.status, 201);
  return result.body;
}

test("legacy message drafts stay private in snapshots, sync, search, conversation reads, and downloads", { timeout: 45_000 }, async (t) => {
  const userIds: string[] = [];
  let uploadId: string | undefined;
  let messageId: string | undefined;
  let conversationId: string | undefined;
  let uploadStorageKey: string | undefined;
  t.after(async () => {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
    await client.connect();
    try {
      if (uploadId) {
        const result = await client.query<{ storage_key: string }>("SELECT storage_key FROM uploads WHERE id=$1", [uploadId]);
        uploadStorageKey ??= result.rows[0]?.storage_key;
      }
      if (messageId) await client.query("DELETE FROM messages WHERE id=$1", [messageId]);
      if (conversationId) await client.query("DELETE FROM conversations WHERE id=$1", [conversationId]);
      if (uploadId) await client.query("DELETE FROM uploads WHERE id=$1", [uploadId]);
      if (userIds.length) await client.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    } finally {
      await client.end();
    }
    if (uploadStorageKey) {
      try {
        await unlink(join(process.env.STORAGE_DIR ?? join(process.cwd(), "storage"), uploadStorageKey));
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  });
  const a = await register(await randomTestPhone());
  userIds.push(a.user.id);
  const b = await register(await randomTestPhone());
  userIds.push(b.user.id);
  const conversation = await request("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [b.user.phone] }),
  }, a.token);
  assert.equal(conversation.response.status, 201);
  conversationId = conversation.body.conversation.id;

  const uploadStart = await request("/api/uploads", {
    method: "POST",
    headers: {
      "x-filename": "private-draft.txt",
      "x-expected-bytes": String(Buffer.byteLength(attachmentBytes)),
      "x-upload-mode": "resumable",
      "content-type": "application/octet-stream",
    },
    body: "",
  }, a.token);
  assert.equal(uploadStart.response.status, 201);
  uploadId = uploadStart.body.upload.id;
  const uploaded = await fetch(`${base}/api/uploads/${uploadId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${a.token}`,
      "content-type": "application/octet-stream",
      "x-upload-offset": "0",
    },
    body: attachmentBytes,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(uploaded.status, 200);

  messageId = randomUUID();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  await client.connect();
  let attachmentId = "";
  try {
    await client.query("BEGIN");
    const upload = await client.query<{ storage_key: string; filename: string; mime_type: string; size_bytes: number }>(
      "SELECT storage_key,filename,mime_type,size_bytes FROM uploads WHERE id=$1 AND user_id=$2 AND status='ready'",
      [uploadId, a.user.id],
    );
    assert.equal(upload.rowCount, 1);
    const file = upload.rows[0];
    uploadStorageKey = file.storage_key;
    await client.query(
      `INSERT INTO messages(id,conversation_id,sender_email,sender_user_id,subject,body,folder)
       VALUES($1,$2,$3,$4,$5,$6,'drafts')`,
      [messageId, conversationId, a.user.email, a.user.id, secretSubject, secretBody],
    );
    await client.query(
      "INSERT INTO message_recipients(message_id,email,role,recipient_user_id) VALUES($1,$2,'to',$3)",
      [messageId, b.user.email, b.user.id],
    );
    const attachment = await client.query<{ id: string }>(
      `INSERT INTO attachments(message_id,filename,mime_type,size_bytes,storage_key)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [messageId, file.filename, file.mime_type, file.size_bytes, file.storage_key],
    );
    attachmentId = attachment.rows[0].id;
    await client.query(
      "INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder) VALUES($1,$2,TRUE,FALSE,'drafts'),($3,$2,FALSE,FALSE,'inbox')",
      [a.user.id, messageId, b.user.id],
    );
    await client.query(
      `INSERT INTO account_changes(user_id,entity_type,entity_id,action,payload)
       VALUES($1,'message',$2,'created',$3::jsonb)`,
      [b.user.id, messageId, JSON.stringify({ subject: secretSubject, body: secretBody, attachmentId })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const aConversation = await request(`/api/conversations/${conversationId}/messages?page=1&pageSize=100`, {}, a.token);
  assert.equal(aConversation.response.status, 200);
  const aMessage = aConversation.body.messages.find((message: any) => message.id === messageId);
  assert.equal(aMessage.subject, secretSubject);
  assert.equal(aMessage.body, secretBody);
  assert.ok(aMessage.recipients.some((recipient: any) => recipient.email === b.user.email));
  assert.ok(aMessage.attachments.some((attachment: any) => attachment.id === attachmentId));

  const bConversation = await request(`/api/conversations/${conversationId}/messages?page=1&pageSize=100`, {}, b.token);
  assert.equal(bConversation.response.status, 200);
  assert.equal(bConversation.body.messages.some((message: any) => message.id === messageId), false);
  const bSearch = await request(`/api/conversations?q=${encodeURIComponent(secretSubject)}`, {}, b.token);
  assert.equal(bSearch.response.status, 200);
  assert.equal(bSearch.body.conversations.some((item: any) => item.id === conversationId), false);
  const bDownload = await fetch(`${base}/api/uploads/${attachmentId}`, {
    headers: { authorization: `Bearer ${b.token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(bDownload.status, 404);
  const aDownload = await fetch(`${base}/api/uploads/${attachmentId}`, {
    headers: { authorization: `Bearer ${a.token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(aDownload.status, 200);
  assert.equal(await aDownload.text(), attachmentBytes);

  async function snapshot(token: string) {
    const records: any[] = [];
    let page = await request("/api/sync/snapshot?limit=100", {}, token);
    assert.equal(page.response.status, 200);
    const snapshotId = page.body.snapshotId;
    let count = 0;
    while (true) {
      records.push(...page.body.records);
      if (!page.body.hasMore) {
        assert.equal(page.body.incrementalCursor, String(page.body.watermark));
        break;
      }
      const nextCursor = page.body.nextCursor;
      assert.ok(nextCursor);
      page = await request(`/api/sync/snapshot?snapshotId=${snapshotId}&cursor=${nextCursor}&limit=100`, {}, token);
      assert.equal(page.response.status, 200);
      count += 1;
      assert.ok(count < 100, "snapshot pages must terminate");
    }
    return records;
  }

  const aSnapshot = await snapshot(a.token);
  const aDraftRecord = aSnapshot.find((record) => record.entity_type === "message" && record.entity_id === messageId);
  assert.ok(aDraftRecord);
  assert.equal(aDraftRecord.payload.subject, secretSubject);
  assert.equal(Object.hasOwn(aDraftRecord.payload, "body"), false);
  assert.ok(aDraftRecord.payload.recipients.some((recipient: any) => recipient.email === b.user.email));
  assert.ok(aDraftRecord.payload.attachments.some((attachment: any) => attachment.id === attachmentId));
  const ownerDetail = await request(`/api/conversations/${conversationId}/messages/${messageId}`, {}, a.token);
  assert.equal(ownerDetail.response.status, 200);
  assert.equal(ownerDetail.body.message.body, secretBody);
  const recipientDetail = await request(`/api/conversations/${conversationId}/messages/${messageId}`, {}, b.token);
  assert.equal(recipientDetail.response.status, 404);

  const bSnapshot = await snapshot(b.token);
  assert.equal(bSnapshot.some((record) => record.entity_id === messageId), false);
  assert.equal(JSON.stringify(bSnapshot).includes(secretSubject), false);
  assert.equal(JSON.stringify(bSnapshot).includes(secretBody), false);
  assert.equal(JSON.stringify(bSnapshot).includes(attachmentId), false);

  const changes: any[] = [];
  let sync = await request("/api/sync?cursor=0&limit=100", {}, b.token);
  assert.equal(sync.response.status, 200);
  changes.push(...sync.body.changes);
  let pages = 0;
  while (sync.body.hasMore) {
    sync = await request(`/api/sync?cursor=${sync.body.cursor}&limit=100`, {}, b.token);
    assert.equal(sync.response.status, 200);
    changes.push(...sync.body.changes);
    pages += 1;
    assert.ok(pages < 100, "incremental pages must terminate");
  }
  assert.equal(changes.some((change) => change.entity_id === messageId), false);
  assert.equal(JSON.stringify(changes).includes(secretSubject), false);
  assert.equal(JSON.stringify(changes).includes(secretBody), false);
});
