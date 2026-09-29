import { randomUUID } from "node:crypto";
import { pool, query } from "../db";
import { HttpError } from "../httpError";

type DraftInput = { subject?: string; body?: string; to?: string[]; cc?: string[] };

const MAX_BIGINT_CURSOR = 9_223_372_036_854_775_807n;
const MAX_SNAPSHOT_RECORDS = 10_000;
const MAX_SNAPSHOT_PAGES_PER_MINUTE = 600;
const MAX_SNAPSHOTS_PER_MINUTE = 5;
const MAX_ACTIVE_SNAPSHOTS = 5;
const MAX_ACTIVE_STREAMING_SNAPSHOTS = 4;
const STREAMING_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const SNAPSHOT_INSTANCE_ID = randomUUID();
const SNAPSHOT_ENTITY_TYPES = ["account", "address", "block", "contact", "conversation", "draft", "message", "upload"] as const;
type SnapshotEntityType = (typeof SNAPSHOT_ENTITY_TYPES)[number];
type StreamingSnapshot = {
  userId: string;
  watermark: string;
  totalRecords: string;
  expiresAt: Date;
  client: import("pg").PoolClient;
  expiryTimer: NodeJS.Timeout;
};
const streamingSnapshots = new Map<string, StreamingSnapshot>();
let streamingSnapshotReservations = 0;

function parseBigintCursor(value: string | undefined): string {
  if (value === undefined) return "0";
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_BIGINT_CURSOR) {
    throw new HttpError(400, "Invalid sync cursor", "INVALID_CURSOR");
  }
  return value;
}

function parseSnapshotKeysetCursor(value: string | undefined): { type: string; id: string } {
  if (value === undefined || value === "0") {
    return { type: "", id: "00000000-0000-0000-0000-000000000000" };
  }
  const separator = value.lastIndexOf(":");
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (separator < 1 || !SNAPSHOT_ENTITY_TYPES.includes(type as SnapshotEntityType) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "Invalid sync snapshot cursor", "INVALID_CURSOR");
  }
  return { type, id };
}

function draft(row: any) {
  return {
    id: row.id, subject: row.subject, body: row.body,
    to: row.to_addresses, cc: row.cc_addresses,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listDrafts(userId: string) {
  const result = await query(`SELECT * FROM drafts WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`, [userId]);
  return result.rows.map(draft);
}

export async function getDraft(userId: string, id: string) {
  const result = await query(`SELECT * FROM drafts WHERE id = $1 AND user_id = $2`, [id, userId]);
  if (!result.rows[0]) throw new HttpError(404, "Draft not found", "NOT_FOUND");
  return draft(result.rows[0]);
}

export async function saveDraft(userId: string, id: string | undefined, input: DraftInput, revision?: number) {
  if (input.subject !== undefined && (typeof input.subject !== "string" || input.subject.length > 200)) throw new HttpError(400, "subject is invalid", "VALIDATION_ERROR");
  if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 100000)) throw new HttpError(400, "body is invalid", "VALIDATION_ERROR");
  for (const values of [input.to, input.cc]) if (values !== undefined && (!Array.isArray(values) || values.length > 50 || values.some((v) => typeof v !== "string"))) throw new HttpError(400, "recipient list is invalid", "VALIDATION_ERROR");
  if (!id) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await lockChangeAccounts(client, [userId]);
      const result = await client.query(`INSERT INTO drafts (user_id, subject, body, to_addresses, cc_addresses) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING *`,
        [userId, input.subject ?? "", input.body ?? "", JSON.stringify(input.to ?? []), JSON.stringify(input.cc ?? [])]);
      const value = draft(result.rows[0]);
      await recordChange(client, userId, "draft", value.id, "upserted", value);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const result = await client.query(`UPDATE drafts SET subject = COALESCE($3,subject), body = COALESCE($4,body), to_addresses = COALESCE($5::jsonb,to_addresses), cc_addresses = COALESCE($6::jsonb,cc_addresses), revision = revision + 1, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND ($7::int IS NULL OR revision = $7) RETURNING *`,
      [id, userId, input.subject ?? null, input.body ?? null, input.to === undefined ? null : JSON.stringify(input.to), input.cc === undefined ? null : JSON.stringify(input.cc), revision ?? null]);
    if (!result.rows[0]) {
      const exists = await client.query(`SELECT 1 FROM drafts WHERE id = $1 AND user_id = $2`, [id, userId]);
      throw new HttpError(exists.rowCount ? 409 : 404, exists.rowCount ? "Draft revision conflict" : "Draft not found", exists.rowCount ? "REVISION_CONFLICT" : "NOT_FOUND");
    }
    const value = draft(result.rows[0]);
    await recordChange(client, userId, "draft", value.id, "upserted", value);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteDraft(userId: string, id: string, revision?: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const result = await client.query(
      `DELETE FROM drafts WHERE id = $1 AND user_id = $2 AND ($3::int IS NULL OR revision = $3) RETURNING id`,
      [id, userId, revision ?? null],
    );
    if (!result.rowCount) throw new HttpError(409, "Draft revision conflict or draft not found", "REVISION_CONFLICT");
    await recordChange(client, userId, "draft", id, "deleted", { id, deleted: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function syncChanges(
  userId: string,
  cursor?: string,
  limit = 50,
  afterRetentionCheck?: () => Promise<void>,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1 to 100", "VALIDATION_ERROR");
  const since = parseBigintCursor(cursor);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const retention = await client.query<{ pruned_through_revision: string }>(
      "SELECT COALESCE(pruned_through_revision, 0)::text AS pruned_through_revision FROM account_sync_state WHERE user_id = $1",
      [userId],
    );
    if (BigInt(since) < BigInt(retention.rows[0]?.pruned_through_revision ?? "0")) {
      throw new HttpError(410, "Sync cursor expired; perform a fresh snapshot", "CURSOR_EXPIRED");
    }
    await afterRetentionCheck?.();
    const result = await client.query(
      `SELECT c.revision::text AS revision, c.entity_type, c.entity_id, c.action, c.payload, c.created_at,
              CASE WHEN c.entity_type <> 'message' THEN TRUE ELSE EXISTS (
                SELECT 1 FROM messages m
                WHERE m.id = c.entity_id AND (
                  m.sender_user_id = c.user_id OR (
                    m.folder <> 'drafts'
                    AND EXISTS (SELECT 1 FROM conversation_members cm
                                 WHERE cm.conversation_id = m.conversation_id AND cm.user_id = c.user_id)
                    AND COALESCE((SELECT ums.folder FROM user_message_state ums
                                  WHERE ums.user_id = c.user_id AND ums.message_id = m.id), m.folder) <> 'drafts'
                  )
                )
              ) END AS authorized
         FROM account_changes c
        WHERE c.user_id = $1 AND c.revision > $2
        ORDER BY c.revision ASC
        LIMIT $3`,
      [userId, since, limit + 1],
    );
    const scanned = result.rows.slice(0, limit);
    const changes = scanned.filter((change) => change.authorized).map(({ authorized: _authorized, ...change }) => change);
    const next = scanned.length ? String(scanned[scanned.length - 1].revision) : since;
    await client.query("COMMIT");
    return { changes, cursor: next, hasMore: result.rows.length > limit, serverTime: new Date().toISOString() };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createSyncSnapshot(userId: string, limit = 50, snapshotId?: string, cursor?: string) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1 to 100", "VALIDATION_ERROR");
  await reserveSnapshotPage(userId);
  if (!snapshotId) await reserveSnapshotCreation(userId);
  const id = snapshotId ?? await materializeSnapshot(userId);
  const header = await query<{
    id: string; watermark: string; expires_at: Date; total_records: string;
    snapshot_mode: string; owner_instance: string;
  }>(
    "SELECT id, watermark::text, expires_at, total_records::text, snapshot_mode, owner_instance FROM sync_snapshot_sessions WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (!header.rows[0]) {
    const foreign = await query<{ user_id: string; expires_at: Date }>("SELECT user_id, expires_at FROM sync_snapshot_sessions WHERE id = $1", [id]);
    if (foreign.rows[0]?.user_id === userId && foreign.rows[0].expires_at.getTime() <= Date.now()) {
      throw new HttpError(410, "Snapshot expired; start a new snapshot", "SNAPSHOT_EXPIRED");
    }
    throw new HttpError(404, "Snapshot not found", "NOT_FOUND");
  }
  if (header.rows[0].expires_at.getTime() <= Date.now()) {
    if (header.rows[0].snapshot_mode === "streaming") await closeStreamingSnapshot(id);
    await query("DELETE FROM sync_snapshot_sessions WHERE id=$1 AND user_id=$2", [id, userId]);
    throw new HttpError(410, "Snapshot expired; start a new snapshot", "SNAPSHOT_EXPIRED");
  }
  if (header.rows[0].snapshot_mode === "streaming") {
    const snapshot = streamingSnapshots.get(id);
    if (!snapshot || snapshot.userId !== userId || snapshot.expiresAt.getTime() <= Date.now()) {
      await closeStreamingSnapshot(id);
      if (header.rows[0].expires_at.getTime() <= Date.now()) {
        await query("DELETE FROM sync_snapshot_sessions WHERE id=$1 AND user_id=$2", [id, userId]);
        throw new HttpError(410, "Snapshot expired; start a new snapshot", "SNAPSHOT_EXPIRED");
      }
      if (header.rows[0].owner_instance !== SNAPSHOT_INSTANCE_ID) {
        throw new HttpError(409, "Large snapshot continuation requires routing to its originating API instance; retry through the same session-affinity route or restart after the snapshot expires", "SNAPSHOT_INSTANCE_AFFINITY_REQUIRED", true);
      }
      throw new HttpError(410, "Streaming snapshot state expired or the API restarted; start a fresh snapshot", "SNAPSHOT_RESTARTED");
    }
    return readStreamingSnapshotPage(id, snapshot, limit, parseSnapshotKeysetCursor(cursor));
  }
  const after = parseBigintCursor(cursor);
  const page = await query(
    `SELECT ordinal::text AS cursor, entity_type, entity_id, payload
       FROM sync_snapshot_rows
      WHERE snapshot_id = $1 AND ordinal > $2::bigint
      ORDER BY ordinal ASC
      LIMIT $3`,
    [id, after, limit + 1],
  );
  const hasMore = page.rows.length > limit;
  const records = page.rows.slice(0, limit);
  const next = records.length ? String(records[records.length - 1].cursor) : String(after);
  return {
    snapshotId: id,
    watermark: header.rows[0].watermark,
    records,
    totalRecords: header.rows[0].total_records,
    hasMore,
    nextCursor: hasMore ? next : null,
    incrementalCursor: hasMore ? null : String(header.rows[0].watermark),
    expiresAt: header.rows[0].expires_at.toISOString(),
    serverTime: new Date().toISOString(),
  };
}

export async function closeSyncSnapshot(userId: string, id: string): Promise<void> {
  const snapshot = await query<{ snapshot_mode: string; owner_instance: string }>(
    "SELECT snapshot_mode,owner_instance FROM sync_snapshot_sessions WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  if (!snapshot.rows[0]) throw new HttpError(404, "Snapshot not found", "NOT_FOUND");
  if (snapshot.rows[0].snapshot_mode === "streaming" && snapshot.rows[0].owner_instance !== SNAPSHOT_INSTANCE_ID) {
    throw new HttpError(409, "Large snapshot must be closed through its originating API instance", "SNAPSHOT_INSTANCE_AFFINITY_REQUIRED", true);
  }
  if (snapshot.rows[0].snapshot_mode === "streaming") await closeStreamingSnapshot(id);
  await query("DELETE FROM sync_snapshot_sessions WHERE id=$1 AND user_id=$2", [id, userId]);
}

async function reserveSnapshotPage(userId: string): Promise<void> {
  const result = await query(
    `INSERT INTO sync_snapshot_request_limits(user_id,window_started_at,request_count)
     VALUES($1,now(),1)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at=CASE
         WHEN sync_snapshot_request_limits.window_started_at <= now()-interval '1 minute' THEN now()
         ELSE sync_snapshot_request_limits.window_started_at END,
       request_count=CASE
         WHEN sync_snapshot_request_limits.window_started_at <= now()-interval '1 minute' THEN 1
         ELSE sync_snapshot_request_limits.request_count+1 END
     WHERE sync_snapshot_request_limits.window_started_at <= now()-interval '1 minute'
        OR sync_snapshot_request_limits.request_count < $2
     RETURNING user_id`,
    [userId, MAX_SNAPSHOT_PAGES_PER_MINUTE],
  );
  if (!result.rowCount) {
    throw new HttpError(429, "Sync snapshot request limit reached", "RATE_LIMITED", true, { retryAfter: "60" });
  }
}

async function reserveSnapshotCreation(userId: string): Promise<void> {
  const result = await query(
    `INSERT INTO sync_snapshot_create_limits(user_id,window_started_at,request_count)
     VALUES($1,now(),1)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at=CASE
         WHEN sync_snapshot_create_limits.window_started_at <= now()-interval '1 minute' THEN now()
         ELSE sync_snapshot_create_limits.window_started_at END,
       request_count=CASE
         WHEN sync_snapshot_create_limits.window_started_at <= now()-interval '1 minute' THEN 1
         ELSE sync_snapshot_create_limits.request_count+1 END
     WHERE sync_snapshot_create_limits.window_started_at <= now()-interval '1 minute'
        OR sync_snapshot_create_limits.request_count < $2
     RETURNING user_id`,
    [userId, MAX_SNAPSHOTS_PER_MINUTE],
  );
  if (!result.rowCount) {
    throw new HttpError(429, "Sync snapshot creation limit reached", "SNAPSHOT_RATE_LIMITED", true, { retryAfter: "60" });
  }
}

async function closeStreamingSnapshot(id: string): Promise<void> {
  const snapshot = streamingSnapshots.get(id);
  if (!snapshot) return;
  streamingSnapshots.delete(id);
  clearTimeout(snapshot.expiryTimer);
  await snapshot.client.query("ROLLBACK").catch(() => undefined);
  snapshot.client.release();
}

export async function closeAllStreamingSnapshots(): Promise<void> {
  await Promise.all([...streamingSnapshots.keys()].map(closeStreamingSnapshot));
}

const SNAPSHOT_COUNT_SQL = `
  SELECT (
    (SELECT count(*) FROM users WHERE id=$1)
    + (SELECT count(*) FROM addresses WHERE user_id=$1)
    + (SELECT count(*) FROM user_blocks WHERE blocker_user_id=$1)
    + (SELECT count(*) FROM contacts WHERE owner_user_id=$1)
    + (SELECT count(*) FROM conversations c WHERE EXISTS (
        SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=$1))
    + (SELECT count(*) FROM drafts WHERE user_id=$1)
    + (SELECT count(*) FROM messages m WHERE EXISTS (
        SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.user_id=$1)
        AND (m.sender_user_id=$1 OR (m.folder<>'drafts' AND
          COALESCE((SELECT ums.folder FROM user_message_state ums WHERE ums.user_id=$1 AND ums.message_id=m.id),m.folder)<>'drafts')))
    + (SELECT count(*) FROM uploads WHERE user_id=$1 AND status IN ('staged','ready'))
  )::text AS total`;

const SNAPSHOT_PAGE_SQL = `
  WITH entities AS (
    (SELECT 'account'::text AS entity_type,u.id AS entity_id,
      jsonb_build_object('id',u.id,'phone',u.phone_normalized,'displayName',u.display_name,
        'language',u.language,'profilePictureUrl',u.profile_picture_url,'signupChannel',u.signup_channel,
        'hasMobileApp',u.has_mobile_app,'phoneVerifiedAt',u.phone_verified_at,
        'phoneVerificationProvenance',u.phone_verification_provenance,
        'preferences',jsonb_build_object('smsEnabled',COALESCE(np.sms_enabled,TRUE),'ivrEnabled',COALESCE(np.ivr_enabled,FALSE),
          'discoverable',COALESCE(np.discoverable,TRUE),'profileVisible',COALESCE(np.profile_visible,TRUE),
          'readReceipts',COALESCE(np.read_receipts,TRUE),'communicationEnabled',COALESCE(np.communication_enabled,TRUE))) AS payload
       FROM users u LEFT JOIN notification_preferences np ON np.user_id=u.id
      WHERE u.id=$1 AND ('account'>$4 OR ('account'=$4 AND u.id>$5::uuid))
      ORDER BY u.id LIMIT $3)
    UNION ALL
    (SELECT 'address',a.id,jsonb_build_object('id',a.id,'email',a.email,'primary',a.is_primary,'alias',a.is_alias,'isActive',a.is_active)
       FROM addresses a WHERE a.user_id=$1 AND ('address'>$4 OR ('address'=$4 AND a.id>$5::uuid))
      ORDER BY a.id LIMIT $3)
    UNION ALL
    (SELECT 'block',b.blocked_user_id,jsonb_build_object('userId',b.blocked_user_id,'createdAt',b.created_at)
       FROM user_blocks b WHERE b.blocker_user_id=$1 AND ('block'>$4 OR ('block'=$4 AND b.blocked_user_id>$5::uuid))
      ORDER BY b.blocked_user_id LIMIT $3)
    UNION ALL
    (SELECT 'contact',c.id,jsonb_build_object('id',c.id,'userId',c.contact_user_id,'address',c.address_snapshot,
        'label',c.label,'notes',c.notes,'createdAt',c.created_at,'updatedAt',c.updated_at)
       FROM contacts c WHERE c.owner_user_id=$1 AND ('contact'>$4 OR ('contact'=$4 AND c.id>$5::uuid))
      ORDER BY c.id LIMIT $3)
    UNION ALL
    (SELECT 'conversation',c.id,jsonb_build_object('id',c.id,'kind',c.kind,'createdAt',c.created_at,'updatedAt',c.updated_at,
        'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId',cm.user_id,'email',cm.email) ORDER BY cm.email)
          FROM conversation_members cm WHERE cm.conversation_id=c.id),'[]'::jsonb))
       FROM conversations c WHERE EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=$1)
         AND ('conversation'>$4 OR ('conversation'=$4 AND c.id>$5::uuid))
      ORDER BY c.id LIMIT $3)
    UNION ALL
    (SELECT 'draft',d.id,jsonb_build_object('id',d.id,'subject',d.subject,'to',d.to_addresses,'cc',d.cc_addresses,
        'revision',d.revision,'createdAt',d.created_at,'updatedAt',d.updated_at)
       FROM drafts d WHERE d.user_id=$1 AND ('draft'>$4 OR ('draft'=$4 AND d.id>$5::uuid))
      ORDER BY d.id LIMIT $3)
    UNION ALL
    (SELECT 'message',m.id,jsonb_build_object('id',m.id,'conversationId',m.conversation_id,'senderEmail',m.sender_email,
        'senderUserId',m.sender_user_id,'subject',m.subject,'inReplyToId',m.in_reply_to_id,'createdAt',m.created_at,
        'recipients',COALESCE((SELECT jsonb_agg(jsonb_build_object('email',mr.email,'role',mr.role,'recipientUserId',mr.recipient_user_id) ORDER BY mr.role,mr.email)
          FROM message_recipients mr WHERE mr.message_id=m.id),'[]'::jsonb),
        'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'mimeType',a.mime_type,
          'sizeBytes',a.size_bytes,'scanStatus',a.scanner_state,'createdAt',a.created_at) ORDER BY a.id)
          FROM attachments a WHERE a.message_id=m.id),'[]'::jsonb),
        'state',(SELECT jsonb_build_object('read',ums.is_read,'favorite',ums.is_favorite,'folder',ums.folder)
          FROM user_message_state ums WHERE ums.user_id=$1 AND ums.message_id=m.id))
       FROM messages m WHERE EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.user_id=$1)
         AND (m.sender_user_id=$1 OR (m.folder<>'drafts' AND
           COALESCE((SELECT ums.folder FROM user_message_state ums WHERE ums.user_id=$1 AND ums.message_id=m.id),m.folder)<>'drafts'))
         AND ('message'>$4 OR ('message'=$4 AND m.id>$5::uuid))
      ORDER BY m.id LIMIT $3)
    UNION ALL
    (SELECT 'upload',u.id,jsonb_build_object('id',u.id,'filename',u.filename,'mimeType',u.mime_type,
        'sizeBytes',u.size_bytes,'status',u.status,'scanStatus',u.scanner_state,'offsetBytes',u.offset_bytes,'expiresAt',u.expires_at)
       FROM uploads u WHERE u.user_id=$1 AND u.status IN ('staged','ready')
         AND ('upload'>$4 OR ('upload'=$4 AND u.id>$5::uuid))
      ORDER BY u.id LIMIT $3)
  )
  SELECT entity_type,entity_id,payload,entity_type||':'||entity_id::text AS cursor
    FROM entities WHERE $2::uuid IS NOT NULL ORDER BY entity_type,entity_id LIMIT $3`;

async function readStreamingSnapshotPage(
  id: string,
  snapshot: StreamingSnapshot,
  limit: number,
  after: { type: string; id: string },
) {
  const page = await snapshot.client.query(
    SNAPSHOT_PAGE_SQL,
    [snapshot.userId, id, limit + 1, after.type, after.id],
  );
  const hasMore = page.rows.length > limit;
  const records = page.rows.slice(0, limit);
  const nextCursor = records.length ? String(records[records.length - 1].cursor) : null;
  return {
    snapshotId: id,
    watermark: snapshot.watermark,
    records,
    totalRecords: snapshot.totalRecords,
    hasMore,
    nextCursor: hasMore ? nextCursor : null,
    incrementalCursor: hasMore ? null : snapshot.watermark,
    expiresAt: snapshot.expiresAt.toISOString(),
    serverTime: new Date().toISOString(),
  };
}

async function createStreamingSnapshot(userId: string): Promise<string> {
  if (streamingSnapshots.size + streamingSnapshotReservations >= MAX_ACTIVE_STREAMING_SNAPSHOTS) {
    throw new HttpError(429, "Large snapshot resources are busy; retry after another transfer finishes or expires", "SNAPSHOT_RESOURCE_LIMIT", true, { retryAfter: "30" });
  }
  streamingSnapshotReservations += 1;
  const id = randomUUID();
  let metadataClient: import("pg").PoolClient | undefined;
  let lockClient: import("pg").PoolClient | undefined;
  let snapshotClient: import("pg").PoolClient | undefined;
  let metadataTransaction = false;
  let metadataInserted = false;
  let accountLock = false;
  let snapshotTransaction = false;
  try {
    metadataClient = await pool.connect();
    await metadataClient.query("BEGIN");
    metadataTransaction = true;
    await metadataClient.query("SELECT pg_advisory_xact_lock(hashtext('phonemail.sync_snapshot_runtime'))");
    await metadataClient.query("DELETE FROM sync_snapshot_sessions WHERE expires_at<=now()");
    const activeUser = await metadataClient.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sync_snapshot_sessions WHERE user_id=$1 AND expires_at>now()",
      [userId],
    );
    if (activeUser.rows[0].count >= MAX_ACTIVE_SNAPSHOTS) {
      throw new HttpError(429, "Too many active sync snapshots; retry after an existing snapshot expires", "SNAPSHOT_LIMIT", true, { retryAfter: "60" });
    }
    const activeGlobal = await metadataClient.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sync_snapshot_sessions WHERE snapshot_mode='streaming' AND owner_instance=$1 AND expires_at>now()",
      [SNAPSHOT_INSTANCE_ID],
    );
    if (activeGlobal.rows[0].count >= MAX_ACTIVE_STREAMING_SNAPSHOTS) {
      throw new HttpError(429, "Large snapshot resources are busy; retry later", "SNAPSHOT_RESOURCE_LIMIT", true, { retryAfter: "30" });
    }

    lockClient = await pool.connect();
    await lockClient.query("SELECT pg_advisory_lock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
    accountLock = true;
    snapshotClient = await pool.connect();
    await snapshotClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    snapshotTransaction = true;
    const watermarkResult = await snapshotClient.query<{ watermark: string }>(
      `SELECT GREATEST(COALESCE((SELECT MAX(revision) FROM account_changes WHERE user_id=$1),0),
                       COALESCE((SELECT pruned_through_revision FROM account_sync_state WHERE user_id=$1),0))::text AS watermark`,
      [userId],
    );
    const count = await snapshotClient.query<{ total: string }>(SNAPSHOT_COUNT_SQL, [userId]);
    const watermark = watermarkResult.rows[0].watermark;
    const totalRecords = count.rows[0].total;
    const expiresAt = new Date(Date.now() + STREAMING_SNAPSHOT_TTL_MS);
    await metadataClient.query(
      `INSERT INTO sync_snapshot_sessions(id,user_id,watermark,total_records,expires_at,snapshot_mode,owner_instance)
       VALUES($1,$2,$3,$4,now()+interval '15 minutes','streaming',$5)`,
      [id, userId, watermark, totalRecords, SNAPSHOT_INSTANCE_ID],
    );
    metadataInserted = true;
    await metadataClient.query("COMMIT");
    metadataTransaction = false;
    await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
    accountLock = false;
    lockClient.release();
    lockClient = undefined;
    const expiryTimer = setTimeout(() => { void closeStreamingSnapshot(id); }, STREAMING_SNAPSHOT_TTL_MS);
    expiryTimer.unref();
    streamingSnapshots.set(id, { userId, watermark, totalRecords, expiresAt, client: snapshotClient, expiryTimer });
    snapshotClient = undefined;
    metadataInserted = false;
    return id;
  } catch (error) {
    if (snapshotTransaction && snapshotClient) await snapshotClient.query("ROLLBACK").catch(() => undefined);
    if (metadataTransaction && metadataClient) await metadataClient.query("ROLLBACK").catch(() => undefined);
    if (metadataInserted && metadataClient) {
      await metadataClient.query("DELETE FROM sync_snapshot_sessions WHERE id=$1", [id]).catch(() => undefined);
    }
    if (accountLock && lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
        accountLock = false;
      } catch {
        lockClient.release(true);
        lockClient = undefined;
      }
    }
    throw error;
  } finally {
    metadataClient?.release();
    if (lockClient) accountLock ? lockClient.release(true) : lockClient.release();
    snapshotClient?.release();
    streamingSnapshotReservations -= 1;
  }
}

async function materializeSnapshot(userId: string): Promise<string> {
  const client = await pool.connect();
  const id = randomUUID();
  let transactionOpen = false;
  let released = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
    await client.query("DELETE FROM sync_snapshot_sessions WHERE expires_at<=now()");
    const active = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sync_snapshot_sessions WHERE user_id=$1 AND expires_at > now()",
      [userId],
    );
    if (active.rows[0].count >= MAX_ACTIVE_SNAPSHOTS) {
      throw new HttpError(429, "Too many active sync snapshots; retry after an existing snapshot expires", "SNAPSHOT_LIMIT", true, { retryAfter: "86400" });
    }
    const watermark = await client.query<{ watermark: string }>(
      `SELECT GREATEST(COALESCE((SELECT MAX(revision) FROM account_changes WHERE user_id = $1),0),
                       COALESCE((SELECT pruned_through_revision FROM account_sync_state WHERE user_id = $1),0))::text AS watermark`,
      [userId],
    );
    await client.query(
      "INSERT INTO sync_snapshot_sessions (id,user_id,watermark) VALUES ($1,$2,$3)",
      [id, userId, watermark.rows[0].watermark],
    );
    await client.query(
      `WITH entities(entity_type, entity_id, payload) AS (
         SELECT 'account', u.id,
           jsonb_build_object('id',u.id,'phone',u.phone_normalized,'displayName',u.display_name,
             'language',u.language,'profilePictureUrl',u.profile_picture_url,'signupChannel',u.signup_channel,
             'hasMobileApp',u.has_mobile_app,'phoneVerifiedAt',u.phone_verified_at,
             'phoneVerificationProvenance',u.phone_verification_provenance,
             'preferences',jsonb_build_object('smsEnabled',COALESCE(np.sms_enabled,TRUE),'ivrEnabled',COALESCE(np.ivr_enabled,FALSE),
               'discoverable',COALESCE(np.discoverable,TRUE),'profileVisible',COALESCE(np.profile_visible,TRUE),
               'readReceipts',COALESCE(np.read_receipts,TRUE),'communicationEnabled',COALESCE(np.communication_enabled,TRUE)))
           FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE u.id = $1
         UNION ALL
         SELECT 'address', a.id, jsonb_build_object('id',a.id,'email',a.email,'primary',a.is_primary,'alias',a.is_alias,'isActive',a.is_active)
           FROM addresses a WHERE a.user_id = $1
         UNION ALL
         SELECT 'draft', d.id, jsonb_build_object('id',d.id,'subject',d.subject,'to',d.to_addresses,
           'cc',d.cc_addresses,'revision',d.revision,'createdAt',d.created_at,'updatedAt',d.updated_at)
           FROM drafts d WHERE d.user_id = $1
         UNION ALL
         SELECT 'contact', c.id, jsonb_build_object('id',c.id,'userId',c.contact_user_id,'address',c.address_snapshot,
           'label',c.label,'notes',c.notes,'createdAt',c.created_at,'updatedAt',c.updated_at)
           FROM contacts c WHERE c.owner_user_id = $1
         UNION ALL
         SELECT 'block', b.blocked_user_id, jsonb_build_object('userId',b.blocked_user_id,'createdAt',b.created_at)
           FROM user_blocks b WHERE b.blocker_user_id = $1
         UNION ALL
         SELECT 'conversation', c.id, jsonb_build_object('id',c.id,'kind',c.kind,'createdAt',c.created_at,'updatedAt',c.updated_at,
           'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId',cm.user_id,'email',cm.email) ORDER BY cm.email)
             FROM conversation_members cm WHERE cm.conversation_id = c.id),'[]'::jsonb))
           FROM conversations c WHERE EXISTS (
             SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = $1
           )
         UNION ALL
         SELECT 'message', m.id, jsonb_build_object('id',m.id,'conversationId',m.conversation_id,
           'senderEmail',m.sender_email,'senderUserId',m.sender_user_id,'subject',m.subject,
           'inReplyToId',m.in_reply_to_id,'createdAt',m.created_at,'recipients',
             COALESCE((SELECT jsonb_agg(jsonb_build_object('email',mr.email,'role',mr.role,'recipientUserId',mr.recipient_user_id) ORDER BY mr.role,mr.email)
               FROM message_recipients mr WHERE mr.message_id = m.id),'[]'::jsonb),
           'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,
               'mimeType',a.mime_type,'sizeBytes',a.size_bytes,'scanStatus',a.scanner_state,'createdAt',a.created_at) ORDER BY a.id)
               FROM attachments a WHERE a.message_id = m.id),'[]'::jsonb),
           'state',(SELECT jsonb_build_object('read',ums.is_read,'favorite',ums.is_favorite,'folder',ums.folder)
               FROM user_message_state ums WHERE ums.user_id = $1 AND ums.message_id = m.id))
           FROM messages m WHERE EXISTS (
             SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id AND cm.user_id = $1
           ) AND (m.sender_user_id = $1 OR (
             m.folder <> 'drafts'
             AND COALESCE((SELECT ums.folder FROM user_message_state ums
                           WHERE ums.user_id = $1 AND ums.message_id = m.id), m.folder) <> 'drafts'
           ))
         UNION ALL
         SELECT 'upload', u.id, jsonb_build_object('id',u.id,'filename',u.filename,'mimeType',u.mime_type,
           'sizeBytes',u.size_bytes,'status',u.status,'scanStatus',u.scanner_state,'offsetBytes',u.offset_bytes,'expiresAt',u.expires_at)
           FROM uploads u WHERE u.user_id = $1 AND u.status IN ('staged','ready')
       ), ordered AS (
         SELECT row_number() OVER (ORDER BY entity_type,entity_id)::bigint AS ordinal, entity_type,entity_id,payload
         FROM entities
         ORDER BY entity_type,entity_id
         LIMIT $3
       )
       INSERT INTO sync_snapshot_rows(snapshot_id,ordinal,entity_type,entity_id,payload)
       SELECT $2,ordinal,entity_type,entity_id,payload FROM ordered`,
      [userId, id, MAX_SNAPSHOT_RECORDS + 1],
    );
    const count = await client.query<{ total: string }>("SELECT count(*)::text AS total FROM sync_snapshot_rows WHERE snapshot_id = $1", [id]);
    if (BigInt(count.rows[0].total) > BigInt(MAX_SNAPSHOT_RECORDS)) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      client.release();
      released = true;
      return await createStreamingSnapshot(userId);
    }
    await client.query("UPDATE sync_snapshot_sessions SET total_records = $2 WHERE id = $1", [id, count.rows[0].total]);
    await client.query("COMMIT");
    transactionOpen = false;
    return id;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (!released) client.release();
  }
}

export async function pruneSyncHistory(userId: string, before: Date, batchLimit = 1000) {
  if (!(before instanceof Date) || !Number.isFinite(before.getTime()) ||
      !Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 10000) {
    throw new HttpError(400, "Invalid sync retention request", "VALIDATION_ERROR");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
    const deleted = await client.query<{ revision: string }>(
      `WITH old AS (
         SELECT revision FROM account_changes
          WHERE user_id = $1 AND created_at < $2
          ORDER BY revision ASC LIMIT $3
       ), removed AS (
         DELETE FROM account_changes c USING old
          WHERE c.revision = old.revision
          RETURNING c.revision
       )
       SELECT revision::text FROM removed ORDER BY revision`,
      [userId, before, batchLimit],
    );
    if (deleted.rows.length) {
      const through = deleted.rows[deleted.rows.length - 1].revision;
      await client.query(
        `INSERT INTO account_sync_state(user_id,pruned_through_revision,updated_at)
         VALUES ($1,$2,now())
         ON CONFLICT (user_id) DO UPDATE SET
           pruned_through_revision = GREATEST(account_sync_state.pruned_through_revision,EXCLUDED.pruned_through_revision),
           updated_at = now()`,
        [userId, through],
      );
    }
    await client.query("COMMIT");
    return { removed: deleted.rows.length, prunedThroughRevision: deleted.rows.at(-1)?.revision ?? null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordChange(client: { query: (text: string, values?: any[]) => Promise<any> }, userId: string, type: string, id: string, action: string, payload: object = {}) {
  // Each account has an independent commit-ordered stream. The transaction lock
  // is held until commit, so an issued revision cannot be observed before its
  // predecessor commits, without serializing unrelated accounts.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
  await client.query("INSERT INTO account_changes (user_id, entity_type, entity_id, action, payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [userId, type, id, action, JSON.stringify(payload)]);
}

export async function lockChangeAccounts(client: { query: (text: string, values?: any[]) => Promise<any> }, userIds: string[]) {
  for (const userId of [...new Set(userIds)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${userId}`]);
  }
}

export function createLeaseToken() { return randomUUID(); }
