import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { MailTransport } from "../src/transport";

export type CapturedTlsMail = { raw: Buffer; envelope: string[] };

export async function withSmtpTlsTransport(
  certificateVariable: string,
  keyVariable: string,
  exercise: (transport: MailTransport, received: CapturedTlsMail[]) => Promise<void>,
): Promise<void> {
  const certificatePath = process.env[certificateVariable];
  const keyPath = process.env[keyVariable];
  if (!certificatePath || !keyPath) {
    throw new Error("SMTP TLS tests require generated local certificate fixtures");
  }
  const server = new SMTPServer({
    name: "127.0.0.1",
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
    authOptional: true,
    socketTimeout: 3000,
    closeTimeout: 1000,
    onData(stream, session: SMTPServerSession, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        received.push({
          raw: Buffer.concat(chunks),
          envelope: session.envelope.rcptTo.map((recipient) => recipient.address),
        });
        callback(null, "250 TLS fixture accepted");
      });
    },
  });
  const received: CapturedTlsMail[] = [];
  let transport: MailTransport | undefined;
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
    process.env.DATABASE_URL = "postgres://phonemail:phonemail@127.0.0.1:1/phonemail_tls_test";
    process.env.JWT_SECRET = "smtp-tls-test-only-secret-that-is-long-enough";
    process.env.MAIL_TRANSPORT_MODE = "smtp";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(address.port);
    process.env.SMTP_TLS_MODE = "starttls";
    process.env.SMTP_TIMEOUT_MS = "3000";
    process.env.SMTP_MAX_CONNECTIONS = "1";
    process.env.SMTP_USERNAME = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_INBOUND_ENABLED = "false";
    process.env.PHONE_DEFAULT_COUNTRY = "";
    const { SmtpMailTransport } = await import("../src/transport");
    transport = new SmtpMailTransport();
    await exercise(transport, received);
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
