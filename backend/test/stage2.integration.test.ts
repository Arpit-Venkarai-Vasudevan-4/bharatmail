import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "../src/db";
import { claimOutbox, finishOutbox } from "../src/outbox";
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { Client } from "pg";
import { pruneSyncHistory, recordChange } from "../src/services/stage2Service";
import { cleanupUploads } from "../src/uploadRecovery";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();
const suffix = randomUUID().slice(0, 8);

async function raw(path: string, init: RequestInit = {}, auth?: { token?: string; cookie?: string; csrf?: string }) {
  const headers: Record<string, string> = { ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> ?? {}) };
  if (auth?.token) headers.authorization = `Bearer ${auth.token}`;
  if (auth?.cookie) headers.cookie = auth.cookie;
  if (auth?.csrf) headers["x-csrf-token"] = auth.csrf;
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function register(phone: string) {
  const result = await raw("/api/auth/register", { method: "POST", body: JSON.stringify({ phone, password: "secret123", termsAccepted: true }) });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body;
}

async function chunkedUpload(token: string, expectedBytes: number, filename: string, chunks: Buffer[]) {
  const target = new URL(`${base}/api/uploads`);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(target, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/octet-stream",
        "x-expected-bytes": String(expectedBytes),
        "x-filename": filename,
        "transfer-encoding": "chunked",
      },
    }, (response) => {
      const received: Buffer[] = [];
      response.on("data", (chunk: Buffer) => received.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(received).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function uploadWithFalseContentLength(token: string, filename: string) {
  const target = new URL(`${base}/api/uploads`);
  return new Promise<boolean>((resolve) => {
    const socket = netConnect(Number(target.port), target.hostname);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      socket.destroy();
    }, 5000);
    socket.on("connect", () => {
      socket.write([
        "POST /api/uploads HTTP/1.1",
        `Host: ${target.host}`,
        `Authorization: Bearer ${token}`,
        "Content-Type: application/octet-stream",
        "X-Expected-Bytes: 5",
        `X-Filename: ${filename}`,
        "Content-Length: 10",
        "Connection: close",
        "",
        "short",
      ].join("\r\n"));
      socket.end();
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(timedOut);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(timedOut);
    });
  });
}

test("Stage 2 auth, drafts, sync, resumable uploads, ranges, and outbox leases", async (t) => {
  const phones = await Promise.all([randomTestPhone(), randomTestPhone()]);
  const a = await register(phones[0]);
  const b = await register(phones[1]);
  const cPhone = await randomTestPhone();
  const c = await register(cPhone);

  const cookieLogin = await raw("/api/auth/login", {
    method: "POST",
    headers: { "x-auth-transport": "cookie" },
    body: JSON.stringify({ phone: phones[0], password: "secret123" }),
  });

  await t.test("OTP registration consumes proof atomically and prevents replay under concurrent login", async () => {
    const phone = await randomTestPhone();
    const normalizedPhone = phoneIdentity(phone);
    const challengeId = randomUUID();
    const signupCode = "582104";
    const hashSecret = process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET ?? "test-secret";
    const codeHash = createHmac("sha256", hashSecret).update(`${challengeId}:${signupCode}`).digest("hex");
    await query(
      `INSERT INTO otp_challenges
         (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES ($1,'signup',$2,$3,now()+interval '5 minutes',now(),$4,'local_mock')`,
      [challengeId, normalizedPhone, codeHash, `local-${challengeId}`],
    );

    const invalidTerms = await raw("/api/auth/otp/register", {
      method: "POST",
      body: JSON.stringify({ phone, challengeId, code: signupCode, purpose: "signup", termsAccepted: false }),
    });
    assert.equal(invalidTerms.response.status, 400);
    const challengeBeforeRetry = await query<{ used_at: Date | null }>("SELECT used_at FROM otp_challenges WHERE id = $1", [challengeId]);
    assert.equal(challengeBeforeRetry.rows[0].used_at, null);

    const fixture = randomUUID().replace(/-/g, "");
    const functionName = `test_fail_otp_session_${fixture}`;
    const triggerName = `test_fail_otp_session_${fixture}`;
    try {
      await query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND phone_normalized = '${normalizedPhone}') THEN
          RAISE EXCEPTION 'intentional isolated OTP transaction failure';
        END IF;
        RETURN NEW;
      END;
    $$`);
      await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      const failed = await raw("/api/auth/otp/register", {
        method: "POST",
        body: JSON.stringify({ phone, challengeId, code: signupCode, purpose: "signup", termsAccepted: true }),
      });
      assert.equal(failed.response.status, 500);
      const afterRollback = await query<{ used_at: Date | null; count: string }>(
        `SELECT c.used_at, (SELECT count(*)::text FROM users WHERE phone_normalized = $2) AS count
         FROM otp_challenges c WHERE c.id = $1`,
        [challengeId, normalizedPhone],
      );
      assert.equal(afterRollback.rows[0].used_at, null);
      assert.equal(afterRollback.rows[0].count, "0");
    } finally {
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON sessions`);
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const registered = await raw("/api/auth/otp/register", {
      method: "POST",
      body: JSON.stringify({ phone, challengeId, code: signupCode, purpose: "signup", termsAccepted: true }),
    });
    assert.equal(registered.response.status, 201);
    const replaySignup = await raw("/api/auth/otp/register", {
      method: "POST",
      body: JSON.stringify({ phone, challengeId, code: signupCode, purpose: "signup", termsAccepted: true }),
    });
    assert.equal(replaySignup.response.status, 400);

    const loginChallenge = randomUUID();
    const loginCode = "751903";
    const loginHash = createHmac("sha256", hashSecret).update(`${loginChallenge}:${loginCode}`).digest("hex");
    await query(
      `INSERT INTO otp_challenges
         (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES ($1,'login',$2,$3,now()+interval '5 minutes',now(),$4,'local_mock')`,
      [loginChallenge, normalizedPhone, loginHash, `local-${loginChallenge}`],
    );
    const attempts = await Promise.all([
      raw("/api/auth/otp/login", { method: "POST", body: JSON.stringify({ phone, challengeId: loginChallenge, code: loginCode, purpose: "login" }) }),
      raw("/api/auth/otp/login", { method: "POST", body: JSON.stringify({ phone, challengeId: loginChallenge, code: loginCode, purpose: "login" }) }),
    ]);
    assert.equal(attempts.filter((result) => result.response.status === 200).length, 1);
    assert.equal(attempts.filter((result) => result.response.status === 400).length, 1);
    const replayLogin = await raw("/api/auth/otp/login", {
      method: "POST",
      body: JSON.stringify({ phone, challengeId: loginChallenge, code: loginCode, purpose: "login" }),
    });
    assert.equal(replayLogin.response.status, 400);
  });
  assert.equal(cookieLogin.response.status, 200);
  assert.ok(cookieLogin.body.user);
  const setCookies = cookieLogin.response.headers.getSetCookie();
  const session = setCookies.find((v) => v.startsWith("phonemail_session="))!.split(";")[0];
  const csrf = setCookies.find((v) => v.startsWith("phonemail_csrf="))!.split(";")[0];
  const cookieAuth = { cookie: `${session}; ${csrf}`, csrf: csrf.split("=")[1] };
  const denied = await raw("/api/me", { method: "PATCH", body: JSON.stringify({ displayName: "blocked" }) }, { cookie: session });
  assert.equal(denied.response.status, 403);
  const allowed = await raw("/api/me", { method: "PATCH", body: JSON.stringify({ displayName: "cookie-user" }) }, cookieAuth);
  assert.equal(allowed.response.status, 200);

  const draft = await raw("/api/drafts", { method: "POST", body: JSON.stringify({ subject: "private", body: "draft body" }) }, { token: a.token });
  assert.equal(draft.response.status, 201);
  const draftId = draft.body.draft.id;
  const otherDraft = await raw(`/api/drafts/${draftId}`, {}, { token: b.token });
  assert.equal(otherDraft.response.status, 404);
  const stale = await raw(`/api/drafts/${draftId}`, { method: "PATCH", headers: { "if-match": '"revision-99"' }, body: JSON.stringify({ body: "overwrite" }) }, { token: a.token });
  assert.equal(stale.response.status, 409);
  const updated = await raw(`/api/drafts/${draftId}`, { method: "PATCH", headers: { "if-match": '"revision-1"' }, body: JSON.stringify({ body: "updated" }) }, { token: a.token });
  assert.equal(updated.response.status, 200);

  const conversation = await raw("/api/conversations", { method: "POST", body: JSON.stringify({ participantPhones: [phones[1]] }) }, { token: a.token });
  const conversationId = conversation.body.conversation.id;
  const sent = await raw(`/api/conversations/${conversationId}/messages`, { method: "POST", headers: { "idempotency-key": `stage2-${suffix}-send` }, body: JSON.stringify({ body: "sync body" }) }, { token: a.token });
  assert.equal(sent.response.status, 201);
  const delivery = await raw(`/api/conversations/${conversationId}/messages/${sent.body.message.id}/delivery`, {}, { token: a.token });
  assert.equal(delivery.body.delivery.lifecycleStatus, "committed");
  assert.equal(delivery.body.delivery.recipients[0].status, "local_committed");
  const receiptPreference = await raw("/api/me/preferences", {
    method: "PATCH", body: JSON.stringify({ readReceipts: false }),
  }, { token: b.token });
  assert.equal(receiptPreference.response.status, 200);
  const markRead = await raw(`/api/conversations/${conversationId}/messages/${sent.body.message.id}/state`, {
    method: "PATCH", body: JSON.stringify({ isRead: true }),
  }, { token: b.token });
  assert.equal(markRead.response.status, 204);
  const privateReceipt = await raw(`/api/conversations/${conversationId}/messages/${sent.body.message.id}/delivery`, {}, { token: a.token });
  assert.equal(privateReceipt.body.delivery.recipients[0].is_read, null);
  await raw("/api/me/preferences", { method: "PATCH", body: JSON.stringify({ readReceipts: true }) }, { token: b.token });
  const visibleReceipt = await raw(`/api/conversations/${conversationId}/messages/${sent.body.message.id}/delivery`, {}, { token: a.token });
  assert.equal(visibleReceipt.body.delivery.recipients[0].is_read, true);
  const sendDraft = await raw("/api/drafts", { method: "POST", body: JSON.stringify({ subject: "draft send", body: "draft content", to: [`${phoneIdentity(phones[1])}@phonemail.com`] }) }, { token: a.token });
  const draftSendHeaders = { "if-match": '"revision-1"', "idempotency-key": `stage2-${suffix}-draft-send` };
  const draftResults = await Promise.all(Array.from({ length: 8 }, () =>
    raw(`/api/drafts/${sendDraft.body.draft.id}/send`, { method: "POST", headers: draftSendHeaders, body: JSON.stringify({ conversationId, attachmentIds: [] }) }, { token: a.token }),
  ));
  assert.ok(draftResults.every((result) => result.response.status === 201), JSON.stringify(draftResults.map((result) => ({ status: result.response.status, body: result.body }))));
  assert.equal(new Set(draftResults.map((result) => result.body.message.id)).size, 1);
  const committedDraftSend = await query<{ message_count: number; outbox_count: number }>(
    `SELECT (SELECT count(*)::int FROM messages WHERE id=$1) AS message_count,
            (SELECT count(*)::int FROM outbox_jobs WHERE payload->>'messageId'=$1::text) AS outbox_count`,
    [draftResults[0].body.message.id],
  );
  assert.deepEqual(committedDraftSend.rows[0], { message_count: 1, outbox_count: 1 });
  const postContentionRequest = await raw("/api/conversations?limit=1", {}, { token: a.token });
  assert.equal(postContentionRequest.response.status, 200, JSON.stringify(postContentionRequest.body));
  const draftAfterSend = await raw(`/api/drafts/${sendDraft.body.draft.id}`, {}, { token: a.token });
  assert.equal(draftAfterSend.response.status, 404);
  const replyKey = `stage2-${suffix}-reply`;
  const replyBody = JSON.stringify({ body: "idempotent reply", inReplyToId: sent.body.message.id });
  const firstReply = await raw(`/api/conversations/${conversationId}/messages`, { method: "POST", headers: { "idempotency-key": replyKey }, body: replyBody }, { token: b.token });
  assert.equal(firstReply.response.status, 201);
  const retriedReply = await raw(`/api/conversations/${conversationId}/messages`, { method: "POST", headers: { "idempotency-key": replyKey }, body: replyBody }, { token: b.token });
  assert.equal(retriedReply.response.status, 201);
  assert.equal(retriedReply.body.message.id, firstReply.body.message.id);
  const conflictingReply = await raw(`/api/conversations/${conversationId}/messages`, { method: "POST", headers: { "idempotency-key": replyKey }, body: JSON.stringify({ body: "changed", inReplyToId: sent.body.message.id }) }, { token: b.token });
  assert.equal(conflictingReply.response.status, 409);
  const alteredDedicatedDraft = await raw("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: "altered recipients", body: "must reject", to: [`${phoneIdentity(phones[1])}@phonemail.com`, `${phoneIdentity(cPhone)}@phonemail.com`] }),
  }, { token: a.token });
  assert.equal(alteredDedicatedDraft.response.status, 201);
  const alteredDraftSend = await raw(`/api/drafts/${alteredDedicatedDraft.body.draft.id}/send`, {
    method: "POST",
    headers: { "if-match": '"revision-1"', "idempotency-key": `stage2-${suffix}-role-lock` },
    body: JSON.stringify({ conversationId, attachmentIds: [] }),
  }, { token: a.token });
  assert.equal(alteredDraftSend.response.status, 400);
  const alteredDraftSurvives = await raw(`/api/drafts/${alteredDedicatedDraft.body.draft.id}`, {}, { token: a.token });
  assert.equal(alteredDraftSurvives.response.status, 200);
  const draftMailboxIds = new Set<string>();
  let draftMailboxPage = await raw("/api/conversations/mailbox/drafts?limit=1", {}, { token: a.token });
  assert.equal(draftMailboxPage.response.status, 200);
  while (true) {
    for (const item of draftMailboxPage.body.messages) {
      assert.equal(item.entityType, "draft");
      draftMailboxIds.add(item.id);
    }
    if (!draftMailboxPage.body.hasMore) break;
    draftMailboxPage = await raw(
      `/api/conversations/mailbox/drafts?limit=1&cursor=${encodeURIComponent(draftMailboxPage.body.nextCursor)}`,
      {},
      { token: a.token },
    );
  }
  assert.ok(draftMailboxIds.has(draftId));
  assert.ok(draftMailboxIds.has(alteredDedicatedDraft.body.draft.id));
  assert.equal(draftMailboxIds.size, 2);
  const unsupportedBccDraft = await raw("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: "bcc unsupported", body: "do not silently drop", bcc: [`${phoneIdentity(phones[1])}@phonemail.com`] }),
  }, { token: a.token });
  assert.equal(unsupportedBccDraft.response.status, 400);
  const sync = await raw("/api/sync?limit=20", {}, { token: a.token });
  assert.equal(sync.response.status, 200);
  assert.ok(sync.body.changes.some((change: any) => change.entity_id === sent.body.message.id));
  const beyondSafeInteger = await raw("/api/sync?cursor=9007199254740993&limit=1", {}, { token: a.token });
  assert.equal(beyondSafeInteger.response.status, 200);
  assert.equal(beyondSafeInteger.body.cursor, "9007199254740993");
  const snapshotClient = new Client({ connectionString: databaseUrl });
  await snapshotClient.connect();
  const seededDraftIds: string[] = [];
  try {
    await snapshotClient.query("BEGIN");
    for (let index = 0; index < 250; index += 1) {
      const inserted = await snapshotClient.query<{ id: string }>(
        "INSERT INTO drafts(user_id,subject,body) VALUES($1,$2,$3) RETURNING id",
        [a.user.id, `snapshot-${suffix}-${index}`, `snapshot body ${index}`],
      );
      const id = inserted.rows[0].id;
      seededDraftIds.push(id);
      await recordChange(snapshotClient, a.user.id, "draft", id, "upserted", { id, revision: 1 });
    }
    await snapshotClient.query("COMMIT");
  } catch (error) {
    await snapshotClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await snapshotClient.end();
  }

  const firstSnapshotPage = await raw("/api/sync/snapshot?limit=17", {}, { token: a.token });
  assert.equal(firstSnapshotPage.response.status, 200);
  assert.equal(typeof firstSnapshotPage.body.snapshotId, "string");
  assert.ok(firstSnapshotPage.body.totalRecords >= 250);
  assert.equal(typeof firstSnapshotPage.body.watermark, "string");
  assert.equal(typeof firstSnapshotPage.body.totalRecords, "string");
  assert.equal(firstSnapshotPage.body.records.length, 17);
  const forbiddenSnapshot = await raw(`/api/sync/snapshot?snapshotId=${firstSnapshotPage.body.snapshotId}&cursor=0&limit=17`, {}, { token: b.token });
  assert.equal(forbiddenSnapshot.response.status, 404);

  const newDuringSnapshot = await raw("/api/drafts", {
    method: "POST",
    body: JSON.stringify({ subject: `during-${suffix}`, body: "must arrive incrementally" }),
  }, { token: a.token });
  assert.equal(newDuringSnapshot.response.status, 201);
  const deletedDuringSnapshotId = seededDraftIds[0];
  await raw(`/api/drafts/${deletedDuringSnapshotId}`, { method: "DELETE" }, { token: a.token });

  const snapshotRecords = [...firstSnapshotPage.body.records];
  let snapshotPage = firstSnapshotPage.body;
  let previousCursor = "0";
  let pages = 1;
  while (snapshotPage.hasMore) {
    assert.ok(snapshotPage.nextCursor);
    assert.notEqual(snapshotPage.nextCursor, previousCursor);
    previousCursor = snapshotPage.nextCursor;
    const nextPage = await raw(
      `/api/sync/snapshot?snapshotId=${snapshotPage.snapshotId}&cursor=${encodeURIComponent(snapshotPage.nextCursor)}&limit=17`,
      {},
      { token: a.token },
    );
    assert.equal(nextPage.response.status, 200);
    assert.equal(nextPage.body.snapshotId, firstSnapshotPage.body.snapshotId);
    assert.equal(nextPage.body.watermark, firstSnapshotPage.body.watermark);
    snapshotRecords.push(...nextPage.body.records);
    snapshotPage = nextPage.body;
    pages += 1;
    assert.ok(pages <= Math.ceil(firstSnapshotPage.body.totalRecords / 17) + 1, "snapshot pagination must terminate");
  }
  assert.equal(snapshotRecords.length, Number(firstSnapshotPage.body.totalRecords));
  assert.equal(new Set(snapshotRecords.map((record: any) => record.cursor)).size, snapshotRecords.length);
  const snapshotDrafts = snapshotRecords.filter((record: any) => record.entity_type === "draft");
  assert.equal(snapshotDrafts.length, 250 + 2);
  assert.deepEqual(new Set(snapshotDrafts.map((record: any) => record.entity_id)), new Set([...seededDraftIds, draftId, alteredDedicatedDraft.body.draft.id]));
  assert.equal(snapshotDrafts.some((record: any) => record.entity_id === newDuringSnapshot.body.draft.id), false);
  assert.equal(snapshotPage.incrementalCursor, String(firstSnapshotPage.body.watermark));
  assert.equal(snapshotPage.nextCursor, null);

  for (const pageSize of [1, 10, 50]) {
    const recoveredIds = new Set<string>();
    let recoveryPage = await raw(
      `/api/sync/snapshot?snapshotId=${firstSnapshotPage.body.snapshotId}&cursor=0&limit=${pageSize}`,
      {},
      { token: a.token },
    );
    let recoveryPages = 0;
    while (true) {
      assert.equal(recoveryPage.response.status, 200);
      for (const record of recoveryPage.body.records) recoveredIds.add(record.cursor);
      if (!recoveryPage.body.hasMore) {
        assert.equal(recoveryPage.body.incrementalCursor, firstSnapshotPage.body.watermark);
        break;
      }
      recoveryPage = await raw(
        `/api/sync/snapshot?snapshotId=${firstSnapshotPage.body.snapshotId}&cursor=${encodeURIComponent(recoveryPage.body.nextCursor)}&limit=${pageSize}`,
        {},
        { token: a.token },
      );
      recoveryPages += 1;
      assert.ok(recoveryPages <= Math.ceil(Number(firstSnapshotPage.body.totalRecords) / pageSize));
    }
    assert.equal(recoveredIds.size, Number(firstSnapshotPage.body.totalRecords));
  }

  for (let index = 0; index < 5; index += 1) {
    const limitedSnapshot = await raw("/api/sync/snapshot?limit=1", {}, { token: c.token });
    assert.equal(limitedSnapshot.response.status, 200);
  }
  const overFrequencySnapshot = await raw("/api/sync/snapshot?limit=1", {}, { token: c.token });
  assert.equal(overFrequencySnapshot.response.status, 429);
  assert.equal(overFrequencySnapshot.body.error.code, "SNAPSHOT_RATE_LIMITED");

  const incrementalCursor = snapshotPage.incrementalCursor;
  const incremental: any[] = [];
  let incrementalPage = await raw(`/api/sync?cursor=${incrementalCursor}&limit=1`, {}, { token: a.token });
  assert.equal(incrementalPage.response.status, 200);
  incremental.push(...incrementalPage.body.changes);
  while (incrementalPage.body.hasMore) {
    const nextCursor = incrementalPage.body.cursor;
    incrementalPage = await raw(`/api/sync?cursor=${nextCursor}&limit=1`, {}, { token: a.token });
    assert.equal(incrementalPage.response.status, 200);
    incremental.push(...incrementalPage.body.changes);
    assert.ok(incremental.length < 20, "incremental handoff should terminate");
  }
  assert.ok(incremental.some((change) => change.entity_id === newDuringSnapshot.body.draft.id && change.action === "upserted"));
  assert.ok(incremental.some((change) => change.entity_id === deletedDuringSnapshotId && change.action === "deleted"));

  await query("UPDATE sync_snapshot_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [firstSnapshotPage.body.snapshotId]);
  const expiredSnapshot = await raw(
    `/api/sync/snapshot?snapshotId=${firstSnapshotPage.body.snapshotId}&cursor=0&limit=17`,
    {},
    { token: a.token },
  );
  assert.equal(expiredSnapshot.response.status, 410);
  const pruned = await pruneSyncHistory(a.user.id, new Date(Date.now() + 1000), 10000);
  assert.ok(pruned.removed > 0);
  assert.ok(BigInt(pruned.prunedThroughRevision ?? "0") > BigInt(snapshotPage.incrementalCursor));
  const expiredIncremental = await raw(`/api/sync?cursor=${snapshotPage.incrementalCursor}&limit=1`, {}, { token: a.token });
  assert.equal(expiredIncremental.response.status, 410, JSON.stringify(expiredIncremental.body));
  const resnapshot = await raw("/api/sync/snapshot?limit=17", {}, { token: a.token });
  assert.equal(resnapshot.response.status, 200);
  assert.equal(resnapshot.body.hasMore, true);

  const upload = await raw("/api/uploads", { method: "POST", headers: { "x-filename": "note.txt", "x-expected-bytes": "11", "x-upload-mode": "resumable", "content-type": "image/png" }, body: "" }, { token: a.token });
  assert.equal(upload.response.status, 201, JSON.stringify(upload.body));
  const uploadId = upload.body.upload.id;
  const initialUploadStatus = await raw(`/api/uploads/${uploadId}/status`, {}, { token: a.token });
  assert.deepEqual(
    { status: initialUploadStatus.body.upload.status, offset: initialUploadStatus.body.upload.offset, scannerState: initialUploadStatus.body.upload.scannerState },
    { status: "staged", offset: 0, scannerState: "unscanned" },
  );
  const first = await raw(`/api/uploads/${uploadId}`, { method: "PATCH", headers: { "x-upload-offset": "0", "content-type": "application/octet-stream" }, body: "hello " }, { token: a.token });
  assert.equal(first.body.upload.offset, 6);
  const reconciledUploadStatus = await raw(`/api/uploads/${uploadId}/status`, {}, { token: a.token });
  assert.equal(reconciledUploadStatus.body.upload.offset, 6);
  const complete = await raw(`/api/uploads/${uploadId}`, { method: "PATCH", headers: { "x-upload-offset": "6", "content-type": "application/octet-stream" }, body: "world" }, { token: a.token });
  assert.equal(complete.body.upload.status, "ready");
  assert.equal(complete.body.upload.mimeType, "application/octet-stream");
  const attached = await raw(`/api/uploads/${uploadId}/attach`, {
    method: "POST", body: JSON.stringify({ messageId: sent.body.message.id }),
  }, { token: a.token });
  assert.equal(attached.response.status, 201);
  assert.equal(attached.body.attachment.scanStatus, "unscanned");
  const attachmentMessage = await raw(`/api/conversations/${conversationId}/messages/${sent.body.message.id}`, {}, { token: a.token });
  assert.equal(attachmentMessage.body.message.attachments[0].scanStatus, "unscanned");
  const attachmentFilter = await raw("/api/conversations?filter=attachments&limit=20", {}, { token: a.token });
  assert.ok(attachmentFilter.body.conversations.some((item: any) => item.id === conversationId));
  const downloadResponse = await fetch(`${base}/api/uploads/${uploadId}`, { headers: { range: "bytes=0-4", authorization: `Bearer ${a.token}` } });
  assert.equal(downloadResponse.status, 206);
  assert.equal(await downloadResponse.text(), "hello");
  const unauthorizedDownload = await raw(`/api/uploads/${uploadId}`, {}, { token: b.token });
  assert.equal(unauthorizedDownload.response.status, 404);
  const unsatisfiedRange = await fetch(`${base}/api/uploads/${uploadId}`, { headers: { range: "bytes=11-", authorization: "Bearer " + a.token } });
  assert.equal(unsatisfiedRange.status, 416);
  assert.equal(unsatisfiedRange.headers.get("content-range"), "bytes */11");

  const racingUpload = await raw("/api/uploads", {
    method: "POST",
    headers: { "x-filename": "racing.txt", "x-expected-bytes": "10", "x-upload-mode": "resumable", "content-type": "application/octet-stream" },
    body: "",
  }, { token: a.token });
  const racingId = racingUpload.body.upload.id;
  const competingChunks = await Promise.all([
    raw(`/api/uploads/${racingId}`, { method: "PATCH", headers: { "x-upload-offset": "0", "content-type": "application/octet-stream" }, body: "ABCDE" }, { token: a.token }),
    raw(`/api/uploads/${racingId}`, { method: "PATCH", headers: { "x-upload-offset": "0", "content-type": "application/octet-stream" }, body: "12345" }, { token: a.token }),
  ]);
  assert.equal(competingChunks.filter((result) => result.response.status === 200).length, 1);
  assert.equal(competingChunks.filter((result) => result.response.status === 409).length, 1);
  const winningPrefix = competingChunks[0].response.status === 200 ? "ABCDE" : "12345";
  const finalChunk = await raw(`/api/uploads/${racingId}`, {
    method: "PATCH",
    headers: { "x-upload-offset": "5", "content-type": "application/octet-stream" },
    body: "UVWXY",
  }, { token: a.token });
  assert.equal(finalChunk.response.status, 200);
  assert.equal(finalChunk.body.upload.status, "ready");
  const fullDownload = await fetch(`${base}/api/uploads/${racingId}`, { headers: { authorization: `Bearer ${a.token}`, range: "bytes=0-9" } });
  assert.equal(fullDownload.status, 206);
  assert.equal(await fullDownload.text(), `${winningPrefix}UVWXY`);

  const overLimit = await raw("/api/uploads", {
    method: "POST",
    headers: { "x-filename": "too-large.txt", "x-expected-bytes": "4", "content-type": "application/octet-stream" },
    body: "12345",
  }, { token: a.token });
  assert.equal(overLimit.response.status, 413);
  const abandoned = await query("SELECT count(*)::int AS count FROM uploads WHERE user_id = $1 AND expected_bytes = 4 AND status IN ('staged','ready')", [a.user.id]);
  assert.equal(abandoned.rows[0].count, 0);

  const noLength = await chunkedUpload(a.token, 5, "claimed.png", [Buffer.from("he"), Buffer.from("llo")]);
  assert.equal(noLength.status, 201);
  assert.equal(noLength.body.upload.mimeType, "application/octet-stream");
  assert.equal(noLength.body.upload.scannerState, "unscanned");
  assert.equal(await uploadWithFalseContentLength(a.token, `false-length-${suffix}.bin`), true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rejectedFalseLength = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM uploads WHERE user_id=$1 AND filename=$2",
    [a.user.id, `false-length-${suffix}.bin`],
  );
  assert.equal(rejectedFalseLength.rows[0].count, 0);

  const rollbackUpload = await raw("/api/uploads", {
    method: "POST",
    headers: { "x-filename": "rollback.bin", "x-expected-bytes": "6", "x-upload-mode": "resumable" },
    body: "",
  }, { token: a.token });
  const rollbackId = rollbackUpload.body.upload.id as string;
  const triggerName = `stage2_fail_upload_${suffix}`;
  const functionName = `${triggerName}_fn`;
  await query(`CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.id = '${rollbackId}'::uuid THEN RAISE EXCEPTION 'injected update failure'; END IF; RETURN NEW; END $$`);
  await query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON uploads FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    const failedChunk = await raw(`/api/uploads/${rollbackId}`, {
      method: "PATCH",
      headers: { "x-upload-offset": "0", "content-type": "application/octet-stream" },
      body: "abcdef",
    }, { token: a.token });
    assert.equal(failedChunk.response.status, 500);
    const rolledBackStatus = await raw(`/api/uploads/${rollbackId}/status`, {}, { token: a.token });
    assert.equal(rolledBackStatus.body.upload.offset, 0);
  } finally {
    await query(`DROP TRIGGER IF EXISTS ${triggerName} ON uploads`);
    await query(`DROP FUNCTION IF EXISTS ${functionName}()`);
  }
  const retriedChunk = await raw(`/api/uploads/${rollbackId}`, {
    method: "PATCH",
    headers: { "x-upload-offset": "0", "content-type": "application/octet-stream" },
    body: "abcdef",
  }, { token: a.token });
  assert.equal(retriedChunk.response.status, 200);
  assert.equal(retriedChunk.body.upload.status, "ready");
  const rollbackDownload = await fetch(`${base}/api/uploads/${rollbackId}`, {
    headers: { authorization: "Bearer " + a.token },
  });
  assert.equal(await rollbackDownload.text(), "abcdef");

  for (let index = 0; index < 5; index += 1) {
    await query(
      "INSERT INTO uploads(user_id,storage_key,filename,mime_type,expected_bytes,status) VALUES($1,$2,'reserved.bin','application/octet-stream',$3,'ready')",
      [c.user.id, randomUUID(), 8 * 1024 * 1024],
    );
  }
  const quotaAttempts = await Promise.all(Array.from({ length: 3 }, () => raw("/api/uploads", {
    method: "POST",
    headers: { "x-filename": "quota.bin", "x-expected-bytes": String(10 * 1024 * 1024), "x-upload-mode": "resumable" },
    body: "",
  }, { token: c.token })));
  assert.equal(quotaAttempts.filter((attempt) => attempt.response.status === 201).length, 1);
  assert.equal(quotaAttempts.filter((attempt) => attempt.response.status === 413 && attempt.body.error.code === "UPLOAD_QUOTA_EXCEEDED").length, 2);
  const quotaUploadIds = quotaAttempts.filter((attempt) => attempt.body.upload).map((attempt) => attempt.body.upload.id);
  const quotaRows = await query<{ status: string }>(
    "SELECT status FROM uploads WHERE id=ANY($1::uuid[]) ORDER BY status",
    [quotaUploadIds],
  );
  assert.equal(quotaRows.rows.filter((row) => row.status === "staged").length, 1);

  const cleanupDir = await mkdtemp(join(tmpdir(), "phonemail-upload-cleanup-"));
  const sharedStorageKey = randomUUID();
  const sharedPath = join(cleanupDir, sharedStorageKey);
  try {
    const expiredStorageKey = randomUUID();
    const expiredPath = join(cleanupDir, expiredStorageKey);
    await query(
      `INSERT INTO uploads(user_id,storage_key,filename,mime_type,expected_bytes,status,expires_at)
       VALUES($1,$2,'expired.bin','application/octet-stream',17,'staged',now()-interval '1 second')`,
      [c.user.id, expiredStorageKey],
    );
    await writeFile(expiredPath, "expired upload");
    const expiredCleanup = await cleanupUploads(cleanupDir);
    assert.ok(expiredCleanup.expired >= 1);
    const expiredRow = await query("SELECT 1 FROM uploads WHERE storage_key=$1", [expiredStorageKey]);
    assert.equal(expiredRow.rows.length, 0);
    await assert.rejects(readFile(expiredPath), (error: any) => error.code === "ENOENT");

    const activeStorageKey = randomUUID();
    const activeChunkPath = join(cleanupDir, `${activeStorageKey}.${randomUUID()}.chunk`);
    await query(
      "INSERT INTO uploads(user_id,storage_key,filename,mime_type,expected_bytes,status) VALUES($1,$2,'active.bin','application/octet-stream',17,'staged')",
      [c.user.id, activeStorageKey],
    );
    await writeFile(activeChunkPath, "active chunk");
    await cleanupUploads(cleanupDir);
    assert.equal((await readFile(activeChunkPath)).toString("utf8"), "active chunk");
    await query("UPDATE uploads SET expires_at=now()-interval '1 second' WHERE storage_key=$1", [activeStorageKey]);
    await cleanupUploads(cleanupDir);
    await assert.rejects(readFile(activeChunkPath), (error: any) => error.code === "ENOENT");

    await writeFile(sharedPath, "shared attachment");
    await query(
      "INSERT INTO attachments(message_id,filename,mime_type,size_bytes,storage_key) VALUES($1,'shared.txt','text/plain',17,$2)",
      [sent.body.message.id, sharedStorageKey],
    );
    const sharedCleanup = await cleanupUploads(cleanupDir);
    assert.equal(sharedCleanup.orphaned, 0);
    assert.equal((await readFile(sharedPath)).toString("utf8"), "shared attachment");
    await query("DELETE FROM attachments WHERE message_id=$1 AND storage_key=$2", [sent.body.message.id, sharedStorageKey]);
    const orphanCleanup = await cleanupUploads(cleanupDir);
    assert.equal(orphanCleanup.orphaned, 1);
    await assert.rejects(readFile(sharedPath), (error: any) => error.code === "ENOENT");
  } finally {
    await rmdir(cleanupDir);
  }

  const job = await query("INSERT INTO outbox_jobs (kind, payload) VALUES ('test', '{}'::jsonb) RETURNING id", []);
  await query(
    "UPDATE outbox_jobs SET available_at=now()-interval '100 years', created_at=now()-interval '100 years' WHERE id=$1",
    [job.rows[0].id],
  );
  const firstLease = await claimOutbox(1);
  const ours = firstLease[0];
  assert.ok(ours);
  assert.equal(ours.id, job.rows[0].id);
  await query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [ours.id]);
  const recoveredLease = await claimOutbox(1);
  assert.equal(recoveredLease[0].id, ours.id);
  assert.notEqual(recoveredLease[0].leaseToken, ours.leaseToken);
  assert.equal(await finishOutbox(ours.id, ours.leaseToken, true), false);
  assert.equal(await finishOutbox(recoveredLease[0].id, recoveredLease[0].leaseToken, false, "provider timeout"), true);
  const retryState = await query<{ status: string; attempts: number; seconds: number }>(
    "SELECT status,attempts,EXTRACT(EPOCH FROM (available_at-now()))::int AS seconds FROM outbox_jobs WHERE id=$1",
    [ours.id],
  );
  assert.equal(retryState.rows[0].status, "queued");
  assert.equal(retryState.rows[0].attempts, 2);
  assert.ok(retryState.rows[0].seconds >= 59 && retryState.rows[0].seconds <= 60);
  await query("UPDATE outbox_jobs SET available_at=now()-interval '100 years' WHERE id=$1", [ours.id]);
  const finalLease = await claimOutbox(1);
  assert.equal(finalLease[0].id, ours.id);
  assert.equal(await finishOutbox(finalLease[0].id, finalLease[0].leaseToken, true), true);
  await assert.rejects(claimOutbox(26), RangeError);

});
