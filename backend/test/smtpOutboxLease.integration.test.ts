import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { claimOutbox } from "../src/outbox";
import { processClaimedOutbox } from "../src/outboxWorker";
import { query } from "../src/db";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";

smtpDemoIntegrationTargets();

test("expired SMTP outbox lease is reclaimed once by concurrent workers after restart", { timeout: 10_000 }, async (t) => {
  const id = randomUUID();
  const originalLease = randomUUID();
  let jobId: string | undefined;
  t.after(async () => {
    if (jobId) await query("DELETE FROM outbox_jobs WHERE id=$1", [jobId]);
  });

  const eligible = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM outbox_jobs
      WHERE (status='queued' AND available_at<=now())
         OR (status='leased' AND lease_until<now())`,
  );
  assert.equal(eligible.rows[0].count, 0, "the paused owned worker fixture must have an otherwise idle outbox");
  const inserted = await query<{ id: string }>(
    `INSERT INTO outbox_jobs(kind,payload,status,attempts,available_at,lease_until,lease_token)
     VALUES('smtp.test-lease',$1::jsonb,'leased',1,now(),now()+interval '1 day',$2)
     RETURNING id`,
    [JSON.stringify({ testId: id }), originalLease],
  );
  jobId = inserted.rows[0].id;

  assert.deepEqual(await claimOutbox(1), [], "an unexpired lease must survive a worker restart");
  await query("UPDATE outbox_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId]);

  const [first, second] = await Promise.all([claimOutbox(1), claimOutbox(1)]);
  const claims = [...first, ...second].filter((job) => job.id === jobId);
  assert.equal(claims.length, 1, "concurrent workers must atomically acquire the expired job once");
  assert.notEqual(claims[0].leaseToken, originalLease);

  let handled = 0;
  const stats = await processClaimedOutbox(claims, async (job) => {
    assert.equal(job.id, jobId);
    handled += 1;
  });
  assert.equal(handled, 1);
  assert.deepEqual(stats, { claimed: 1, sent: 1, failed: 0 });
  const finished = await query<{ status: string; attempts: number; lease_token: string | null }>(
    "SELECT status,attempts,lease_token::text FROM outbox_jobs WHERE id=$1",
    [jobId],
  );
  assert.deepEqual(finished.rows[0], { status: "sent", attempts: 2, lease_token: null });
});
