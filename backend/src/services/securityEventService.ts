import { pool, query } from "../db";
import { HttpError } from "../httpError";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_METADATA_KEYS = new Set([
  "authMethod", "channel", "active", "setting", "value",
  "verificationMethod", "accountCreated", "credentialGeneration", "resourceId",
]);

function safeMetadata(input: Record<string, unknown>): Record<string, string | boolean | number> {
  const output: Record<string, string | boolean | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string" && value.length <= 320) output[key] = value;
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isSafeInteger(value))) output[key] = value;
  }
  return output;
}

export async function recordSecurityEvent(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },
  input: {
    userId: string;
    actorUserId?: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    notifyOwner?: boolean;
  },
): Promise<string> {
  const payload = safeMetadata(input.metadata ?? {});
  const inserted = await client.query(
    `INSERT INTO account_audit_events(user_id,actor_user_id,event_type,payload)
     VALUES($1,$2,$3,$4::jsonb) RETURNING id`,
    [input.userId, input.actorUserId ?? input.userId, input.eventType, JSON.stringify(payload)],
  );
  const eventId = inserted.rows[0].id;
  if (input.notifyOwner) {
    await client.query(
      `INSERT INTO security_notifications(user_id,event_id,event_type,payload)
       VALUES($1,$2,$3,$4::jsonb)`,
      [input.userId, eventId, input.eventType, JSON.stringify(payload)],
    );
  }
  return eventId;
}

export async function recordFailedAuthentication(userId: string, authMethod: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.failed_auth:${userId}`]);
    const recent = await client.query(
      `SELECT 1 FROM account_audit_events
        WHERE user_id=$1 AND event_type='authentication_failed'
          AND created_at >= now()-interval '5 minutes'
        LIMIT 1`,
      [userId],
    );
    if (!recent.rowCount) {
      await recordSecurityEvent(client, {
        userId,
        eventType: "authentication_failed",
        metadata: { authMethod },
        notifyOwner: true,
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listSecurityNotifications(userId: string, limit = 25) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, "limit must be 1 to 50", "VALIDATION_ERROR");
  }
  const result = await query(
    `SELECT id,event_type AS "eventType",payload,created_at AS "createdAt",read_at AS "readAt"
       FROM security_notifications
      WHERE user_id=$1
      ORDER BY created_at DESC,id DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows;
}

export async function markSecurityNotificationRead(userId: string, id: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) throw new HttpError(400, "event id must be a UUID", "VALIDATION_ERROR");
  const result = await query(
    "UPDATE security_notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id",
    [id, userId],
  );
  return Boolean(result.rowCount);
}
