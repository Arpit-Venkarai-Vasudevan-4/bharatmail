import assert from "node:assert/strict";
import test from "node:test";
import { withSmtpTlsTransport } from "./smtpTlsHarness";

test("SMTP transport rejects an untrusted STARTTLS certificate", { timeout: 15_000 }, async () => {
  await withSmtpTlsTransport("SMTP_TEST_REJECTED_CERT", "SMTP_TEST_REJECTED_KEY", async (transport) => {
    await assert.rejects(transport.verify!(), (error: unknown) => {
      if (!(error instanceof Error)) return false;
      return /certificate|self-signed|issuer|verify|TLS/i.test(error.message);
    });
  });
});
