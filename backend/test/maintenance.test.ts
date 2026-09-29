import assert from "node:assert/strict";
import { mkdtemp, readFile, utimes, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/phonemail_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "maintenance-unit-test-secret";
process.env.NODE_ENV = "development";
const { cleanupOtpTestSink } = require("../src/maintenance") as typeof import("../src/maintenance");

test("OTP test sink cleanup removes only expired code files", async () => {
  const sink = await mkdtemp(join(tmpdir(), "phonemail-otp-sink-"));
  const stale = join(sink, `${randomUUID()}.code`);
  const fresh = join(sink, `${randomUUID()}.code`);
  const unrelated = join(sink, "notes.txt");
  process.env.OTP_TEST_SINK_DIR = sink;
  try {
    await writeFile(stale, "expired");
    await writeFile(fresh, "valid");
    await writeFile(unrelated, "preserve");
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, oldDate, oldDate);

    assert.equal(await cleanupOtpTestSink(), 1);
    await assert.rejects(readFile(stale), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal((await readFile(fresh)).toString("utf8"), "valid");
    assert.equal((await readFile(unrelated)).toString("utf8"), "preserve");
  } finally {
    delete process.env.OTP_TEST_SINK_DIR;
    await rm(sink, { recursive: true, force: true });
  }
});
