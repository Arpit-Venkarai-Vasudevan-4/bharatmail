import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";
import test from "node:test";
import { config } from "../src/config";
import { query } from "../src/db";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = smtpDemoIntegrationTargets();
const inboundHost = process.env.PHONEMAIL_SMTP_INBOUND_HOST;
const inboundPort = Number(process.env.PHONEMAIL_SMTP_INBOUND_PORT);
if (inboundHost !== "backend" || inboundPort !== 2525) {
  throw new Error("Inbound rollback regression requires the owned Compose SMTP listener");
}

async function request(path: string, token: string) {
  const response = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function sendFixture(to: string[], messageId: string, subject: string) {
  const client = nodemailer.createTransport({
    host: inboundHost,
    port: inboundPort,
    secure: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    return await client.sendMail({
      from: "smtp-rollback-sender@example.test",
      to,
      subject,
      messageId,
      date: new Date("2025-01-01T00:00:00.000Z"),
      text: "Attachment rollback regression fixture",
      attachments: [{
        filename: "durable-fixture.txt",
        content: Buffer.from("committed attachment bytes survive retry"),
      }],
    });
  } finally {
    client.close();
  }
}

test("inbound second-recipient rollback preserves committed attachments and retries without duplicate delivery", async (t) => {
  const baselineFiles = new Set(await readdir(config.storageDir));
  const phones = [await randomTestPhone(), await randomTestPhone()];
  const userIds: string[] = [];
  const fixtureId = randomUUID().replace(/-/g, "");
  const subject = `SMTP rollback ${fixtureId}`;
  const sequenceName = `smtp_rollback_${fixtureId}`;
  const functionName = `smtp_rollback_fn_${fixtureId}`;
  const triggerName = `smtp_rollback_trg_${fixtureId}`;
  let triggerCreated = false;
  let functionCreated = false;
  let sequenceCreated = false;

  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        cleanupErrors.push(error);
        return undefined;
      }
    };
    if (triggerCreated) {
      await cleanup(() => query(`DROP TRIGGER IF EXISTS ${triggerName} ON attachments`));
    }
    if (functionCreated) await cleanup(() => query(`DROP FUNCTION IF EXISTS ${functionName}()`));
    if (sequenceCreated) await cleanup(() => query(`DROP SEQUENCE IF EXISTS ${sequenceName}`));
    const currentFiles = await cleanup(() => readdir(config.storageDir));
    if (Array.isArray(currentFiles)) {
      await Promise.all(currentFiles
        .filter((name): name is string => typeof name === "string" && !baselineFiles.has(name))
        .map((name) => cleanup(() => unlink(join(config.storageDir, name)))));
    }
    if (userIds.length) {
      await cleanup(() => query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]));
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "SMTP rollback regression cleanup failed");
  });

  const accounts: { id: string; phone: string; email: string; token: string }[] = [];
  for (const phone of phones) {
    const response = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
      signal: AbortSignal.timeout(5000),
    });
    const account = await response.json();
    assert.equal(response.status, 201, JSON.stringify(account));
    userIds.push(account.user.id);
    accounts.push({
      id: account.user.id,
      phone: account.user.phone,
      email: account.user.email,
      token: account.token,
    });
  }
  const [first, second] = accounts;

  await query(`CREATE SEQUENCE ${sequenceName} START WITH 1`);
  sequenceCreated = true;
  await query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM messages m
          JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
         WHERE m.id=NEW.message_id
           AND m.subject='${subject}'
           AND cm.user_id='${second.id}'::uuid
      ) AND nextval('${sequenceName}')=1 THEN
        RAISE EXCEPTION 'injected second-recipient attachment failure' USING ERRCODE='40001';
      END IF;
      RETURN NEW;
    END;
    $$`);
  functionCreated = true;
  await query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON attachments FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  triggerCreated = true;

  const messageId = `<smtp-rollback-${fixtureId}@example.test>`;
  await assert.rejects(
    sendFixture([first.email, second.email], messageId, subject),
    (error: unknown) => error instanceof Error && "responseCode" in error && Number(error.responseCode) === 451,
  );

  const afterFailure = await query<{
    message_id: string;
    user_id: string;
    storage_key: string;
    size_bytes: number;
  }>(
    `SELECT m.id AS message_id,ums.user_id,a.storage_key,a.size_bytes
       FROM messages m
       JOIN user_message_state ums ON ums.message_id=m.id
       JOIN attachments a ON a.message_id=m.id
      WHERE m.subject=$1 ORDER BY ums.user_id`,
    [subject],
  );
  assert.equal(afterFailure.rows.length, 1, "only the first recipient's transaction should have committed");
  assert.equal(afterFailure.rows[0].user_id, first.id, "envelope recipient order must be deterministic");
  assert.equal((await readFile(join(config.storageDir, afterFailure.rows[0].storage_key))).toString(),
    "committed attachment bytes survive retry");
  const firstInboxAfterFailure = await request("/api/conversations/mailbox/inbox", first.token);
  const secondInboxAfterFailure = await request("/api/conversations/mailbox/inbox", second.token);
  assert.ok(firstInboxAfterFailure.body.messages.some((message: { id: string }) => message.id === afterFailure.rows[0].message_id));
  assert.equal(secondInboxAfterFailure.body.messages.filter((message: { subject: string }) => message.subject === subject).length, 0);
  const filesAfterFailure = (await readdir(config.storageDir)).filter((name) => !baselineFiles.has(name));
  assert.deepEqual(filesAfterFailure, [afterFailure.rows[0].storage_key],
    "the failed second-recipient attachment must be removed while the committed first remains");

  const retry = await sendFixture([first.email, second.email], messageId, subject);
  assert.ok(retry.accepted.length >= 2, "retry should durably accept both SMTP recipients");
  const afterRetry = await query<{
    message_id: string;
    user_id: string;
    storage_key: string;
    size_bytes: number;
  }>(
    `SELECT m.id AS message_id,ums.user_id,a.storage_key,a.size_bytes
       FROM messages m
       JOIN user_message_state ums ON ums.message_id=m.id
       JOIN attachments a ON a.message_id=m.id
      WHERE m.subject=$1 ORDER BY ums.user_id`,
    [subject],
  );
  assert.equal(afterRetry.rows.length, 2, "retry must leave exactly one mailbox delivery per recipient");
  assert.deepEqual(new Set(afterRetry.rows.map((row) => row.user_id)), new Set([first.id, second.id]));
  assert.equal(afterRetry.rows.find((row) => row.user_id === first.id)?.message_id, afterFailure.rows[0].message_id,
    "the already committed first delivery must not be duplicated");
  assert.deepEqual((await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM inbound_mail_dedup WHERE deduplication_key IS NOT NULL
      AND recipient_user_id=ANY($1::uuid[])`,
    [userIds],
  )).rows[0], { count: 2 });
  const filesAfterRetry = new Set((await readdir(config.storageDir)).filter((name) => !baselineFiles.has(name)));
  assert.deepEqual(filesAfterRetry, new Set(afterRetry.rows.map((row) => row.storage_key)),
    "storage must contain only the two durable attachment files created by the completed delivery");
  for (const row of afterRetry.rows) {
    assert.equal((await readFile(join(config.storageDir, row.storage_key))).toString(),
      "committed attachment bytes survive retry");
  }
  const firstInboxAfterRetry = await request("/api/conversations/mailbox/inbox", first.token);
  const secondInboxAfterRetry = await request("/api/conversations/mailbox/inbox", second.token);
  assert.equal(firstInboxAfterRetry.body.messages.filter((message: { subject: string }) => message.subject === subject).length, 1);
  assert.equal(secondInboxAfterRetry.body.messages.filter((message: { subject: string }) => message.subject === subject).length, 1);
  console.log("PASS second-recipient inbound rollback, attachment preservation, and deduplicated retry");
});
