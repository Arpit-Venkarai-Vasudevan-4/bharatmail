import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/phonemail_unit_test";
process.env.JWT_SECRET = "smtp-test-only-secret-that-is-long-enough";

test("recipient-level SMTP errors are preserved and only eligible recipients are retried", async () => {
  const { classifySmtpDeliveryOutcome } = await import("../src/services/smtpService");
  const delivered = classifySmtpDeliveryOutcome(
    [
      { recipient_email: "ok@example.test", status: "queued", attempts: 0 },
      { recipient_email: "temp@example.test", status: "queued", attempts: 0 },
      { recipient_email: "permanent@example.test", status: "queued", attempts: 0 },
    ],
    {
      accepted: ["ok@example.test"],
      rejected: ["temp@example.test", "permanent@example.test"],
      rejectedDetails: [
        { address: "temp@example.test", code: 450, message: "Mailbox busy" },
        { address: "permanent@example.test", code: 550, message: "Unknown mailbox" },
      ],
      response: "250 2.1.5 OK",
      messageId: "<message@phonemail.test>",
    },
    "smtp",
  );

  assert.deepEqual(delivered.updates.map((entry) => ({ recipient: entry.recipient_email, status: entry.status, attempts: entry.attempts })), [
    { recipient: "ok@example.test", status: "relay_accepted", attempts: 1 },
    { recipient: "temp@example.test", status: "retrying", attempts: 1 },
    { recipient: "permanent@example.test", status: "failed", attempts: 1 },
  ]);
  assert.equal(delivered.shouldRetry, true);
  assert.equal(delivered.ambiguous, false);
});

test("cleanup only removes uncommitted attachment files after a later recipient failure", async () => {
  const { isolateUncommittedAttachmentFiles } = await import("../src/services/smtpService");
  const files = [
    "/tmp/committed-before/first.eml",
    "/tmp/uncommitted/second.eml",
    "/tmp/committed-before/third.eml",
    "/tmp/uncommitted/fourth.eml",
  ];
  const committedPaths = new Set(["/tmp/committed-before/first.eml", "/tmp/committed-before/third.eml"]);
  assert.deepEqual(isolateUncommittedAttachmentFiles(files, committedPaths), [
    "/tmp/uncommitted/second.eml",
    "/tmp/uncommitted/fourth.eml",
  ]);
  assert.equal(isolateUncommittedAttachmentFiles(["/tmp/committed-before/first.eml"], committedPaths).length, 0);
});
