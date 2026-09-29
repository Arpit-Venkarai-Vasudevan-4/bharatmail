import { opendir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";
import { query } from "./db";
import { pruneSyncHistory } from "./services/stage2Service";
import { cleanupUploads } from "./uploadRecovery";

const BATCH = 500;

export async function cleanupOtpTestSink(): Promise<number> {
  const sink = process.env.OTP_TEST_SINK_DIR;
  if (!sink) return 0;
  let directory;
  try {
    directory = await opendir(sink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  const staleBefore = Date.now() - Math.max(config.otp.ttlMs, 60 * 60 * 1000);
  let inspected = 0;
  let removed = 0;
  for await (const file of directory) {
    if (inspected >= BATCH) break;
    if (!file.isFile() || !/^[0-9a-f-]{36}\.code$/i.test(file.name)) continue;
    inspected++;
    const path = join(sink, file.name);
    try {
      if ((await stat(path)).mtimeMs > staleBefore) continue;
      await unlink(path);
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

async function deleteExpired(table: string, key: string, predicate: string, limit = BATCH): Promise<number> {
  const result = await query(
    `WITH expired AS (
       SELECT ${key} FROM ${table} WHERE ${predicate} ORDER BY ${key} LIMIT $1
     )
     DELETE FROM ${table} target USING expired
      WHERE target.${key}=expired.${key}`,
    [limit],
  );
  return result.rowCount ?? 0;
}

async function deleteExpiredByCtid(table: string, predicate: string, limit = BATCH): Promise<number> {
  const result = await query(
    `WITH expired AS (
       SELECT ctid FROM ${table} WHERE ${predicate} ORDER BY ctid LIMIT $1
     )
     DELETE FROM ${table} target USING expired WHERE target.ctid=expired.ctid`,
    [limit],
  );
  return result.rowCount ?? 0;
}

export async function runMaintenance(storageDir: string) {
  const counts: Record<string, number> = {};
  counts.sessions = await deleteExpired("sessions", "id", "expires_at <= now()");
  counts.syncCursors = await deleteExpired("sync_cursors", "token", "expires_at <= now()");
  counts.otpAuthorizations = await deleteExpired(
    "otp_operation_authorizations",
    "challenge_id",
    "expires_at <= now() OR consumed_at < now() - interval '30 days'",
  );
  counts.otpChallenges = await deleteExpired("otp_challenges", "id", "expires_at < now() - interval '1 day'");
  counts.phoneChangeRecoveries = await deleteExpiredByCtid(
    "phone_change_recoveries",
    "expires_at <= now()",
    BATCH,
  );
  counts.idempotencyKeys = await deleteExpiredByCtid("idempotency_keys", "expires_at <= now()");
  counts.authRateLimits = await deleteExpired("auth_rate_limits", "bucket_key", "window_started_at < now() - interval '1 day'");
  counts.otpPhoneRateLimits = await deleteExpired("otp_phone_rate_limits", "phone_normalized", "window_started_at < now() - interval '1 day'");
  counts.otpIpRateLimits = await deleteExpired("otp_ip_rate_limits", "ip_key", "window_started_at < now() - interval '1 day'");
  counts.otpSendLimits = await deleteExpiredByCtid("otp_send_limits", "last_reserved_at < now() - interval '1 day'");
  counts.recipientLimits = await deleteExpired(
    "recipient_confirmation_rate_limits",
    "user_id",
    "window_started_at < now() - interval '1 day'",
  );
  counts.snapshots = await deleteExpired("sync_snapshot_sessions", "id", "expires_at <= now()", 10);
  counts.ivrCalls = await deleteExpired("telecom_ivr_calls", "call_sid", "created_at < now() - interval '90 days'");
  counts.telecomEvents = await deleteExpired(
    "telecom_webhook_events",
    "event_key",
    "completed_at < now() - interval '90 days'",
  );
  counts.providerEvents = await deleteExpired(
    "notification_provider_events",
    "id",
    "received_at < now() - interval '90 days'",
  );
  counts.securityNotifications = await deleteExpiredByCtid(
    "security_notifications",
    "created_at < now() - interval '365 days'",
  );
  counts.accountAuditEvents = await deleteExpiredByCtid(
    "account_audit_events",
    "created_at < now() - interval '365 days'",
  );
  counts.notificationDeliveries = await deleteExpired(
    "notification_deliveries",
    "id",
    "status IN ('delivered','failed','simulated') AND updated_at < now() - interval '180 days'",
  );
  counts.outboxSent = await deleteExpired("outbox_jobs", "id", "status='sent' AND created_at < now() - interval '30 days'");
  counts.outboxFailed = await deleteExpired("outbox_jobs", "id", "status='failed' AND created_at < now() - interval '180 days'");
  counts.otpTestSinkFiles = await cleanupOtpTestSink();

  const oldSyncAccounts = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM account_changes
      WHERE created_at < now() - interval '30 days'
      ORDER BY user_id LIMIT 25`,
  );
  let syncEventsPruned = 0;
  for (const account of oldSyncAccounts.rows) {
    const result = await pruneSyncHistory(account.user_id, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 1000);
    syncEventsPruned += result.removed;
  }
  counts.syncEvents = syncEventsPruned;

  const uploadCleanup = await cleanupUploads(storageDir);
  counts.expiredUploads = uploadCleanup.expired;
  counts.orphanedFiles = uploadCleanup.orphaned;
  return counts;
}
