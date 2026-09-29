import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test from "node:test";
import type { MailTransport } from "../src/transport";

test("SMTP greeting timeout is bounded and releases the socket", { timeout: 7000 }, async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
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
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgres://phonemail:phonemail@127.0.0.1:1/phonemail_timeout_test";
    process.env.JWT_SECRET = "smtp-timeout-test-only-secret-that-is-long-enough";
    process.env.MAIL_TRANSPORT_MODE = "smtp";
    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(address.port);
    process.env.SMTP_TLS_MODE = "plain";
    process.env.SMTP_TIMEOUT_MS = "1000";
    process.env.SMTP_MAX_CONNECTIONS = "1";
    process.env.SMTP_USERNAME = "";
    process.env.SMTP_PASSWORD = "";
    process.env.SMTP_INBOUND_ENABLED = "false";
    process.env.PHONE_DEFAULT_COUNTRY = "";
    const { SmtpMailTransport } = await import("../src/transport");
    transport = new SmtpMailTransport();
    const startedAt = Date.now();
    await assert.rejects(transport.verify!(), (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return /timeout|timed out/i.test(error.message);
    });
    assert.ok(Date.now() - startedAt < 5000, "greeting timeout must fail within the finite SMTP deadline");
  } finally {
    try {
      await transport?.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(resolve));
    }
  }
});
