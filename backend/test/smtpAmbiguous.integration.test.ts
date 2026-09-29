import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import { parsePhoneNumberWithError } from "libphonenumber-js/min";
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
      body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
    });
    if (result.response.status === 201) return result.body;
    if (result.response.status !== 409 || result.body?.error?.code !== "CONFLICT") {
      throw new Error(`Could not create SMTP ambiguity fixture account (${result.response.status})`);
    }
  }
  throw new Error("Could not allocate a valid collision-free SMTP ambiguity fixture phone");
}

test("post-DATA connection loss records acceptance as uncertain", { timeout: 15_000 }, async (t) => {
  const fixtureId = randomUUID().replace(/-/g, "");
  const functionName = `smtp_ambig_fn_${fixtureId}`;
  const triggerName = `smtp_ambig_trg_${fixtureId}`;
  const leaseToken = randomUUID();
  const subject = `SMTP ambiguous ${fixtureId}`;
  let userId: string | undefined;
  let outboxId: string | undefined;
  let functionCreated = false;
  let triggerCreated = false;
  let databaseQuery: DatabaseQuery | undefined;
  const sockets = new Set<Socket>();
  let dataConsumed = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 fixture.example.test ESMTP\r\n");
    let buffer = "";
    let inData = false;
    socket.on("data", (chunk: string | Buffer) => {
      buffer += chunk.toString();
      if (inData) {
        const terminator = buffer.indexOf("\r\n.\r\n");
        if (terminator < 0) return;
        dataConsumed = true;
        socket.destroy();
        return;
      }
      for (;;) {
        const lineEnd = buffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.split(/\s+/, 1)[0].toUpperCase();
        if (command === "EHLO" || command === "HELO") {
          socket.write("250-fixture.example.test\r\n250-PIPELINING\r\n250 SIZE 10485760\r\n");
        } else if (command === "MAIL" || command === "RCPT") {
          socket.write("250 2.1.0 accepted\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
          return;
        } else if (command === "QUIT") {
          socket.end("221 2.0.0 closing\r\n");
          return;
        } else {
          socket.write("250 2.0.0 ok\r\n");
        }
      }
    });
  });
  let transport: MailTransport | undefined;

  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const queryDb = databaseQuery;
    if (triggerCreated && queryDb) await cleanup(() => queryDb(`DROP TRIGGER IF EXISTS ${triggerName} ON outbox_jobs`));
    if (functionCreated && queryDb) await cleanup(() => queryDb(`DROP FUNCTION IF EXISTS ${functionName}()`));
    if (outboxId && queryDb) await cleanup(() => queryDb("DELETE FROM outbox_jobs WHERE id=$1", [outboxId]));
    if (userId && queryDb) await cleanup(() => queryDb("DELETE FROM users WHERE id=$1", [userId]));
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "SMTP ambiguity regression cleanup failed");
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
    const address = server.address();
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
    const account = await registerFixture();
    userId = account.user.id;
    const [database, outboxWorker, smtpService, transportModule] = await Promise.all([
      import("../src/db"),
      import("../src/outboxWorker"),
      import("../src/services/smtpService"),
      import("../src/transport"),
    ]);
    databaseQuery = database.query;
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
      headers: { "Idempotency-Key": `smtp-ambiguous-${fixtureId}` },
      body: JSON.stringify({
        to: ["uncertain@example.test"],
        subject,
        body: "The relay consumes DATA then loses its final response.",
      }),
    }, account.token);
    assert.equal(composed.response.status, 201, JSON.stringify(composed.body));
    const messageId = composed.body.message.id as string;
    const outbox = await database.query<{ id: string; kind: string; payload: { messageId: string }; lease_token: string }>(
      `SELECT id,kind,payload,lease_token::text
         FROM outbox_jobs WHERE kind='message.smtp-delivery' AND payload->>'messageId'=$1::text`,
      [messageId],
    );
    assert.equal(outbox.rows.length, 1);
    outboxId = outbox.rows[0].id;
    assert.equal(outbox.rows[0].lease_token, leaseToken);

    transport = new transportModule.SmtpMailTransport();
    const stats = await outboxWorker.processClaimedOutbox(
      [{ ...outbox.rows[0], leaseToken: outbox.rows[0].lease_token }],
      async (job) => {
        const payload = job.payload as { messageId: string };
        await smtpService.processSmtpDelivery(payload.messageId, transport!);
      },
    );
    assert.equal(dataConsumed, true, "the fixture must disconnect only after the complete DATA payload was consumed");
    assert.deepEqual(stats, { claimed: 1, sent: 0, failed: 1 });
    const delivery = await database.query<{ status: string; attempts: number; last_error: string | null }>(
      "SELECT status,attempts,last_error FROM smtp_message_deliveries WHERE message_id=$1",
      [messageId],
    );
    assert.deepEqual(delivery.rows[0], {
      status: "acceptance_unknown",
      attempts: 1,
      last_error: "SMTP ECONNECTION failure",
    });
    const job = await database.query<{ status: string; attempts: number }>(
      "SELECT status,attempts FROM outbox_jobs WHERE id=$1",
      [outboxId],
    );
    assert.deepEqual(job.rows[0], { status: "queued", attempts: 1 });
    console.log("PASS post-DATA connection loss remains explicitly acceptance_unknown");
  } finally {
    try {
      await transport?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(resolve));
    }
  }
});
