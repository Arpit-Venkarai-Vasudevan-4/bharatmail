import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { parsePhoneNumberWithError } from "libphonenumber-js/min";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import test from "node:test";
import type { MailTransport } from "../src/transport";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";

const { base } = smtpDemoIntegrationTargets();
type DatabaseQuery = typeof import("../src/db").query;

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

async function registerFixture() {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const phone = `+447911${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
    let parsed;
    try {
      parsed = parsePhoneNumberWithError(phone);
    } catch {
      continue;
    }
    if (!parsed.isValid() || parsed.country !== "GB") continue;
    const result = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ phone, country: "GB", password: "StrongPass!123", termsAccepted: true }),
    });
    if (result.response.status === 201) return result.body;
    if (result.response.status !== 409 || result.body?.error?.code !== "CONFLICT") {
      throw new Error(`Could not create SMTP storage fixture account (${result.response.status})`);
    }
  }
  throw new Error("Could not allocate a valid collision-free SMTP storage fixture phone");
}

test("missing attachment storage fails retryably before SMTP acceptance", { timeout: 15_000 }, async (t) => {
  const fixtureId = randomUUID().replace(/-/g, "");
  const functionName = `smtp_storage_fn_${fixtureId}`;
  const triggerName = `smtp_storage_trg_${fixtureId}`;
  const leaseToken = randomUUID();
  let userId: string | undefined;
  let uploadId: string | undefined;
  let messageId: string | undefined;
  let outboxId: string | undefined;
  let uploadStorageKey: string | undefined;
  let databaseQuery: DatabaseQuery | undefined;
  let functionCreated = false;
  let triggerCreated = false;
  let acceptedMessageCount = 0;
  const server = new SMTPServer({
    name: "smtp-storage-fixture.example.test",
    hideSTARTTLS: true,
    authOptional: true,
    socketTimeout: 3000,
    closeTimeout: 1000,
    onData(stream, _session: SMTPServerSession, callback) {
      stream.on("end", () => {
        acceptedMessageCount += 1;
        callback(null, "250 storage fixture accepted");
      });
      stream.resume();
    },
  });
  let transport: MailTransport | undefined;

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
    const queryDb = databaseQuery;
    if (queryDb && uploadId) {
      const result = await cleanup(() => queryDb<{ storage_key: string }>(
        "SELECT storage_key FROM uploads WHERE id=$1",
        [uploadId],
      ));
      if (result && "rows" in result) uploadStorageKey ??= result.rows[0]?.storage_key;
    }
    if (triggerCreated && queryDb) await cleanup(() => queryDb(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_jobs`));
    if (functionCreated && queryDb) await cleanup(() => queryDb(`DROP FUNCTION IF EXISTS ${functionName}()`));
    if (outboxId && queryDb) await cleanup(() => queryDb("DELETE FROM outbox_jobs WHERE id=$1", [outboxId]));
    if (userId && queryDb) await cleanup(() => queryDb("DELETE FROM users WHERE id=$1", [userId]));
    if (uploadStorageKey) {
      await cleanup(() => unlink(join(process.env.STORAGE_DIR ?? join(process.cwd(), "storage"), uploadStorageKey!)));
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "SMTP storage-failure regression cleanup failed");
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.server.address();
    assert.ok(address && typeof address !== "string");
    process.env.NODE_ENV = "development";
    process.env.MAIL_TRANSPORT_MODE = "smtp";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(address.port);
    process.env.SMTP_TLS_MODE = "plain";
    process.env.SMTP_TIMEOUT_MS = "2000";
    process.env.SMTP_MAX_CONNECTIONS = "1";
    process.env.SMTP_USERNAME = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_INBOUND_ENABLED = "false";

    const [database, outboxWorker, smtpService, transportModule] = await Promise.all([
      import("../src/db"),
      import("../src/outboxWorker"),
      import("../src/services/smtpService"),
      import("../src/transport"),
    ]);
    databaseQuery = database.query;
    const account = await registerFixture();
    userId = account.user.id;
    const bytes = Buffer.from(`missing-storage-fixture-${fixtureId}`);
    const started = await request("/api/uploads", {
      method: "POST",
      headers: {
        "x-filename": "missing-storage.txt",
        "x-expected-bytes": String(bytes.length),
        "x-upload-mode": "resumable",
        "content-type": "application/octet-stream",
      },
      body: "",
    }, account.token);
    assert.equal(started.response.status, 201, JSON.stringify(started.body));
    uploadId = started.body.upload.id;
    const uploaded = await fetch(`${base}/api/uploads/${uploadId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${account.token}`,
        "content-type": "application/octet-stream",
        "x-upload-offset": "0",
      },
      body: bytes,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(uploaded.status, 200, await uploaded.text());
    const upload = await database.query<{ storage_key: string }>(
      "SELECT storage_key FROM uploads WHERE id=$1 AND user_id=$2 AND status='ready'",
      [uploadId, userId],
    );
    assert.equal(upload.rowCount, 1);
    uploadStorageKey = upload.rows[0].storage_key;
    const missingStorageKey = randomUUID();
    await database.query(`
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
          NEW.lease_token='${leaseToken}'::uuid;
        END IF;
        RETURN NEW;
      END;
      $$`);
    functionCreated = true;
    await database.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    triggerCreated = true;

    const composed = await request("/api/mail/compose", {
      method: "POST",
      headers: { "Idempotency-Key": `smtp-storage-${fixtureId}` },
      body: JSON.stringify({
        to: [`storage-failure-${fixtureId}@example.test`],
        subject: `SMTP storage failure ${fixtureId}`,
        body: "A missing local attachment must be retried before relay acceptance.",
        attachmentIds: [uploadId],
      }),
    }, account.token);
    assert.equal(composed.response.status, 201, JSON.stringify(composed.body));
    messageId = composed.body.message.id;
    const attachment = await database.query(
      "UPDATE attachments SET storage_key=$2 WHERE message_id=$1 RETURNING id",
      [messageId, missingStorageKey],
    );
    assert.equal(attachment.rowCount, 1);
    const outbox = await database.query<{ id: string; kind: string; payload: { messageId: string }; lease_token: string }>(
      `SELECT id,kind,payload,lease_token::text
         FROM outbox_jobs WHERE kind='message.smtp-delivery' AND payload->>'messageId'=$1::text`,
      [messageId],
    );
    assert.equal(outbox.rows.length, 1);
    outboxId = outbox.rows[0].id;

    transport = new transportModule.SmtpMailTransport();
    const stats = await outboxWorker.processClaimedOutbox(
      [{ ...outbox.rows[0], leaseToken: outbox.rows[0].lease_token }],
      async (job) => {
        const payload = job.payload as { messageId: string };
        await smtpService.processSmtpDelivery(payload.messageId, transport!);
      },
    );
    assert.deepEqual(stats, { claimed: 1, sent: 0, failed: 1 });
    assert.equal(acceptedMessageCount, 0, "the relay must not accept a message whose local attachment is missing");
    const delivery = await database.query<{ status: string; attempts: number; last_error: string | null }>(
      "SELECT status,attempts,last_error FROM smtp_message_deliveries WHERE message_id=$1",
      [messageId],
    );
    assert.equal(delivery.rows[0].status, "retrying", JSON.stringify(delivery.rows[0]));
    assert.equal(delivery.rows[0].attempts, 1);
    assert.match(delivery.rows[0].last_error ?? "", /ESTREAM/);
    const job = await database.query<{ status: string; attempts: number }>(
      "SELECT status,attempts FROM outbox_jobs WHERE id=$1",
      [outboxId],
    );
    assert.deepEqual(job.rows[0], { status: "queued", attempts: 1 });
    console.log("PASS missing local attachment storage is retryable and not acceptance-unknown");
  } finally {
    try {
      await transport?.close();
    } finally {
      if (server.server.listening) await new Promise<void>((resolve) => server.close(resolve));
    }
  }
});
