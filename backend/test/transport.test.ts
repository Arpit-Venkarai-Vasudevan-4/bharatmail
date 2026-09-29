import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleParser } from "mailparser";

test("Nodemailer generates encoded MIME headers and authorized attachment content", async () => {
  process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
  process.env.JWT_SECRET ??= "smtp-transport-test-only-secret";
  const { LocalSmtpAdapter } = await import("../src/transport");
  const directory = await mkdtemp(join(tmpdir(), "phonemail-mail-"));
  const transport = new LocalSmtpAdapter(directory);
  try {
    const result = await transport.send({
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "Résumé",
      text: "hello\nworld",
      messageId: "<stable@example.test>",
      date: new Date("2025-01-01T00:00:00.000Z"),
      attachments: [{ filename: "note.txt", contentType: "text/plain", content: Buffer.from("attachment") }],
    });
    const [file] = await readdir(directory);
    const raw = await readFile(join(directory, file));
    const parsed = await simpleParser(raw);
    assert.equal(parsed.subject, "Résumé");
    assert.equal(parsed.messageId, "<stable@example.test>");
    assert.equal(parsed.text, "hello\nworld");
    assert.equal(parsed.attachments[0]?.content.toString(), "attachment");
  } finally {
    transport.close();
  }
});
