import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import test from "node:test";
import { withSmtpTlsTransport } from "./smtpTlsHarness";

test("SMTP transport completes STARTTLS with a trusted certificate", { timeout: 15_000 }, async () => {
  await withSmtpTlsTransport("SMTP_TEST_TRUSTED_CERT", "SMTP_TEST_TRUSTED_KEY", async (transport, received) => {
    await transport.verify?.();
    const result = await transport.send({
      from: "sender@phonemail.test",
      to: ["tls-recipient@example.test"],
      subject: "Trusted STARTTLS fixture",
      text: "TLS must be negotiated and verified.",
      messageId: "<trusted-starttls@phonemail.test>",
      date: new Date("2025-01-01T00:00:00.000Z"),
    });
    assert.deepEqual(result.accepted, ["tls-recipient@example.test"]);
    assert.deepEqual(received.map((message) => message.envelope), [["tls-recipient@example.test"]]);
    assert.equal((await simpleParser(received[0].raw)).text?.trim(), "TLS must be negotiated and verified.");
  });
});
