import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { config } from "./config";

export type OutboxJob = { id: string; kind: string; payload: unknown; leaseToken: string };
const MAX_OUTBOX_BATCH = 25;

export async function outboxStatusCounts(): Promise<Record<string, string>> {
  const result = await pool.query<{ status: string; count: string }>(
    "SELECT status,count(*)::text AS count FROM outbox_jobs GROUP BY status ORDER BY status",
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, row.count]));
}

export async function claimOutbox(limit = 10): Promise<OutboxJob[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_BATCH) {
    throw new RangeError(`Outbox batch limit must be between 1 and ${MAX_OUTBOX_BATCH}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const token = randomUUID();
    const result = await client.query(
      `WITH candidates AS (
         SELECT id FROM outbox_jobs
          WHERE (status = 'queued' AND available_at <= now())
             OR (status = 'leased' AND lease_until < now())
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE outbox_jobs j
          SET status = 'leased', lease_until = now() + ($3 * interval '1 millisecond'),
              lease_token = $2, attempts = attempts + 1
         FROM candidates c
        WHERE j.id = c.id
       RETURNING j.id, j.kind, j.payload`,
      [limit, token, config.outboxLeaseMs],
    );
    await client.query("COMMIT");
    return result.rows.map((row) => ({ ...row, leaseToken: token }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finishOutbox(id: string, leaseToken: string, success: boolean, error?: string) {
  const safeError = error?.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) ?? null;
  const result = await pool.query<{ status: string }>(
    `UPDATE outbox_jobs SET status = CASE WHEN $3 THEN 'sent' ELSE CASE WHEN attempts >= $5 THEN 'failed' ELSE 'queued' END END,
      lease_until = NULL, lease_token = NULL, last_error = $4,
      available_at = CASE WHEN $3 THEN available_at
                          ELSE now() + (LEAST($6, 30 * power(2, GREATEST(attempts - 1, 0))) * interval '1 second') END
      WHERE id = $1 AND lease_token = $2
      RETURNING status`,
    [id, leaseToken, success, safeError, config.outboxMaxAttempts, Math.ceil(config.outboxMaxRetryDelayMs / 1000)],
  );
  if (!success && result.rows[0]?.status === "failed") {
    await pool.query(
      `UPDATE smtp_message_deliveries
          SET status='failed',last_error='SMTP retry limit exhausted',updated_at=now()
        WHERE message_id=(SELECT (payload->>'messageId')::uuid FROM outbox_jobs WHERE id=$1 AND kind='message.smtp-delivery')
          AND status IN ('queued','retrying')`,
      [id],
    );
  }
  return result.rowCount === 1;
}
