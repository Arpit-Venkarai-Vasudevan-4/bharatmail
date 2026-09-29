import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { MailTransport, OutgoingMail } from "../src/transport";

type CapturedMessage = { raw: Buffer; envelope: string[] };

function setSmtpTestEnvironment(port: number): void {
  process.env.NODE_ENV = "development";
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/phonemail_socket_test";
  process.env.JWT_SECRET = "smtp-socket-test-only-secret-that-is-long-enough";
  process.env.MAIL_TRANSPORT_MODE = "smtp";
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(port);
  process.env.SMTP_TLS_MODE = "plain";
  process.env.SMTP_TIMEOUT_MS = "3000";
  process.env.SMTP_MAX_CONNECTIONS = "1";
  process.env.SMTP_USERNAME = "";
  process.env.SMTP_PASSWORD = "";
  process.env.SMTP_INBOUND_ENABLED = "false";
  process.env.PHONE_DEFAULT_COUNTRY = "";
}

async function withSocketTransport(
  exercise: (server: SMTPServer, transport: MailTransport, received: CapturedMessage[]) => Promise<void>,
  onServerCreated?: (server: SMTPServer) => void,
): Promise<void> {
  const received: CapturedMessage[] = [];
  const server = new SMTPServer({
    name: "smtp-fixture.example.test",
    hideSTARTTLS: true,
    authOptional: true,
    socketTimeout: 3000,
    closeTimeout: 1000,
    onRcptTo(address, _session, callback) {
      if (address.address === "temporary@example.test") {
        const error = new Error("temporary recipient rejection") as Error & { responseCode: number };
        error.responseCode = 450;
        callback(error);
        return;
      }
      if (address.address === "permanent@example.test" || address.address === "refused@example.test") {
        const error = new Error("permanent recipient rejection") as Error & { responseCode: number };
        error.responseCode = 550;
        callback(error);
        return;
      }
      callback();
    },
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        received.push({
          raw: Buffer.concat(chunks),
          envelope: session.envelope.rcptTo.map((recipient) => recipient.address),
        });
        callback(null, "250 fixture accepted");
      });
    },
  });
  let transport: MailTransport | undefined;
  try {
    onServerCreated?.(server);
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
    setSmtpTestEnvironment(address.port);
    const { SmtpMailTransport } = await import("../src/transport");
    transport = new SmtpMailTransport();
    await exercise(server, transport, received);
  } finally {
    try {
      await transport?.close();
    } finally {
      if (server.server.listening) {
        await new Promise<void>((resolve) => server.close(resolve));
      }
    }
  }
}

const outgoingMessage: OutgoingMail = {
  from: "sender@phonemail.test",
  to: ["visible@example.test"],
  cc: ["visible-copy@example.test"],
  envelope: {
    from: "sender@phonemail.test",
    to: ["accepted@example.test", "temporary@example.test", "permanent@example.test"],
  },
  subject: "Unicode – नमस्ते",
  text: "Socket body 🌻",
  messageId: "<stable-socket-test@phonemail.test>",
  date: new Date("2025-01-01T00:00:00.000Z"),
  attachments: [{
    filename: "fixture-attachment.txt",
    contentType: "text/plain",
    content: Buffer.from("SMTP attachment bytes: नमस्ते 🌻", "utf8"),
  }],
};

test("isolated SMTP socket preserves recipient response codes and sends MIME", { timeout: 15000 }, async () => {
  let server: SMTPServer | undefined;
  await assert.rejects(
    withSocketTransport(async (createdServer, transport, received) => {
      const result = await transport.send(outgoingMessage);
      assert.equal(received.length, 1);
      assert.deepEqual(received[0].envelope, ["accepted@example.test"]);
      assert.deepEqual(result.accepted, ["accepted@example.test"]);
      assert.deepEqual(result.rejected, ["temporary@example.test", "permanent@example.test"]);
      assert.deepEqual(result.rejectedDetails.map(({ address, code }) => ({ address, code })), [
        { address: "temporary@example.test", code: 450 },
        { address: "permanent@example.test", code: 550 },
      ]);
      const parsed = await simpleParser(received[0].raw);
      assert.equal(parsed.messageId, outgoingMessage.messageId);
      assert.equal(parsed.subject, outgoingMessage.subject);
      assert.equal(parsed.text?.trimEnd(), outgoingMessage.text);
      assert.deepEqual(parsed.to?.value.map((address) => address.address), ["visible@example.test"]);
      assert.deepEqual(parsed.cc?.value.map((address) => address.address), ["visible-copy@example.test"]);
      assert.equal(parsed.attachments.length, 1);
      assert.equal(parsed.attachments[0].filename, "fixture-attachment.txt");
      assert.equal(parsed.attachments[0].content.toString("utf8"), "SMTP attachment bytes: नमस्ते 🌻");

      await assert.rejects(
        transport.send({
          ...outgoingMessage,
          envelope: { from: outgoingMessage.from, to: ["refused@example.test"] },
        }),
        /all recipients were rejected/i,
      );
      assert.equal(0, 1, "intentional assertion failure to verify resource cleanup");
    }, (createdServer) => {
      server = createdServer;
    }),
    (error: unknown) => error instanceof assert.AssertionError,
  );
  assert.ok(server);
  assert.equal(server.server.listening, false);
});
