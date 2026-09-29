import { pool, query } from "../db";
import { HttpError } from "../httpError";
import { normalizePhone, emailFromPhone, phoneNumberFromPublicIdentity } from "../phone";
import { config } from "../config";
import { lockChangeAccounts, recordChange } from "./stage2Service";

type ContactRow = { id: string; contact_user_id: string | null; address_snapshot: string; label: string; notes: string; created_at: Date; updated_at: Date };
function present(row: ContactRow) {
  return { id: row.id, userId: row.contact_user_id, address: row.address_snapshot, label: row.label, notes: row.notes, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

async function resolveAddress(value: string, country?: string) {
  const trimmed = value.trim().toLowerCase();
  let address: string;
  if (trimmed.includes("@")) {
    address = trimmed;
  } else if (country || trimmed.startsWith("+") || trimmed.startsWith("00")) {
    address = emailFromPhone(normalizePhone(trimmed, country ?? (config.phoneDefaultCountry || undefined)), config.mailDomain);
  } else {
    const publicDigits = phoneNumberFromPublicIdentity(trimmed);
    address = emailFromPhone(publicDigits, config.mailDomain);
    const existing = await query("SELECT 1 FROM addresses WHERE email=$1 AND is_active", [address]);
    if (!existing.rowCount && !config.phoneDefaultCountry) {
      throw new HttpError(400, "National phone input requires a country or a registered PhoneMail address", "PHONE_COUNTRY_REQUIRED");
    }
    if (!existing.rowCount) {
      address = emailFromPhone(normalizePhone(trimmed, config.phoneDefaultCountry), config.mailDomain);
    }
  }
  const result = await query<{ email: string; user_id: string | null }>(
    "SELECT a.email, a.user_id FROM addresses a JOIN users u ON u.id=a.user_id WHERE a.email=$1 AND a.is_active AND u.account_status='active'",
    [address],
  );
  return { address, userId: result.rows[0]?.user_id ?? null };
}

export async function listContacts(ownerUserId: string, search?: string, limit = 50, offset = 0) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new HttpError(400, "Invalid contact pagination", "VALIDATION_ERROR");
  const result = await query<ContactRow>(
    `SELECT c.id, c.contact_user_id,
            COALESCE(primary_address.email, c.address_snapshot) AS address_snapshot,
            c.label, c.notes, c.created_at, c.updated_at
       FROM contacts c
       LEFT JOIN users contact_user ON contact_user.id=c.contact_user_id AND contact_user.account_status='active'
       LEFT JOIN addresses primary_address ON primary_address.user_id=contact_user.id
         AND primary_address.is_primary AND primary_address.is_active
      WHERE c.owner_user_id = $1
       AND ($2 = '' OR c.label ILIKE '%' || $2 || '%' OR c.address_snapshot ILIKE '%' || $2 || '%'
         OR primary_address.email ILIKE '%' || $2 || '%')
      ORDER BY c.updated_at DESC, c.id DESC LIMIT $3 OFFSET $4`,
    [ownerUserId, (search ?? "").trim(), limit, offset],
  );
  return result.rows.map(present);
}

export async function saveContact(ownerUserId: string, input: { address: string; country?: string; label: string; notes?: string }, id?: string) {
  if (typeof input.address !== "string" || typeof input.label !== "string" || !input.label.trim() || input.label.length > 100 || (input.notes ?? "").length > 1000) {
    throw new HttpError(400, "address, label, and bounded notes are required", "VALIDATION_ERROR");
  }
  const resolved = await resolveAddress(input.address, input.country);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [ownerUserId]);
    const result = id
      ? await client.query<ContactRow>(
        `UPDATE contacts SET address_snapshot = $3, contact_user_id = $4, label = $5, notes = $6, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 RETURNING *`,
        [id, ownerUserId, resolved.address, resolved.userId, input.label.trim(), input.notes ?? ""],
      )
      : await client.query<ContactRow>(
        `INSERT INTO contacts (owner_user_id, contact_user_id, address_snapshot, label, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [ownerUserId, resolved.userId, resolved.address, input.label.trim(), input.notes ?? ""],
      );
    if (!result.rows[0]) throw new HttpError(id ? 404 : 409, id ? "Contact not found" : "Contact already exists", id ? "NOT_FOUND" : "CONFLICT");
    const contact = present(result.rows[0]);
    await recordChange(client, ownerUserId, "contact", contact.id, "upserted", contact);
    await client.query("COMMIT");
    return contact;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteContact(ownerUserId: string, id: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [ownerUserId]);
    const result = await client.query("DELETE FROM contacts WHERE id = $1 AND owner_user_id = $2 RETURNING id", [id, ownerUserId]);
    if (!result.rowCount) throw new HttpError(404, "Contact not found", "NOT_FOUND");
    await recordChange(client, ownerUserId, "contact", id, "deleted", { id, deleted: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function confirmRecipient(ownerUserId: string, value: string, country?: string) {
  const rate = await query(
    `INSERT INTO recipient_confirmation_rate_limits(user_id,window_started_at,request_count)
     VALUES($1,now(),1)
     ON CONFLICT(user_id) DO UPDATE SET
       window_started_at = CASE WHEN recipient_confirmation_rate_limits.window_started_at <= now() - interval '1 minute' THEN now() ELSE recipient_confirmation_rate_limits.window_started_at END,
       request_count = CASE WHEN recipient_confirmation_rate_limits.window_started_at <= now() - interval '1 minute' THEN 1 ELSE recipient_confirmation_rate_limits.request_count + 1 END
     WHERE recipient_confirmation_rate_limits.window_started_at <= now() - interval '1 minute'
        OR recipient_confirmation_rate_limits.request_count < 60
     RETURNING window_started_at`,
    [ownerUserId],
  );
  if (!rate.rowCount) {
    throw new HttpError(429, "Recipient confirmation limit reached; try again later", "RATE_LIMITED", true, { retryAfter: "60" });
  }
  const resolved = await resolveAddress(value, country);
  if (!resolved.userId || resolved.userId === ownerUserId) return { available: false, address: resolved.address };
  const result = await query<{ display_name: string | null; account_status: string; discoverable: boolean; profile_visible: boolean }>(
    `SELECT u.display_name, u.account_status, COALESCE(np.discoverable, TRUE) AS discoverable,
            COALESCE(np.profile_visible, TRUE) AS profile_visible
       FROM users u LEFT JOIN notification_preferences np ON np.user_id = u.id WHERE u.id = $1`,
    [resolved.userId],
  );
  if (result.rows[0]?.account_status !== "active" || !result.rows[0]?.discoverable) return { available: false, address: resolved.address };
  return result.rows[0].profile_visible
    ? { available: true, address: resolved.address, displayName: result.rows[0].display_name }
    : { available: true, address: resolved.address };
}

export async function setBlock(blockerUserId: string, blockedUserId: string, blocked: boolean) {
  if (blockerUserId === blockedUserId) throw new HttpError(400, "Cannot block yourself", "VALIDATION_ERROR");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [blockerUserId]);
    const result = blocked
      ? await client.query(
        "INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING blocked_user_id",
        [blockerUserId, blockedUserId],
      )
      : await client.query(
        "DELETE FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2 RETURNING blocked_user_id",
        [blockerUserId, blockedUserId],
      );
    if (result.rowCount) {
      await recordChange(client, blockerUserId, "block", blockedUserId, blocked ? "upserted" : "deleted",
        blocked ? { userId: blockedUserId } : { userId: blockedUserId, deleted: true });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function assertNotBlocked(senderUserId: string, recipientUserIds: string[], db = { query } as { query: typeof query }) {
  if (!recipientUserIds.length) return;
  const result = await db.query(
    `SELECT 1 FROM user_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[]))
       OR (blocked_user_id = $1 AND blocker_user_id = ANY($2::uuid[])) LIMIT 1`,
    [senderUserId, recipientUserIds],
  );
  const communication = await db.query(
    `SELECT 1 FROM users u
       LEFT JOIN notification_preferences np ON np.user_id = u.id
      WHERE u.id = ANY($1::uuid[])
        AND (u.account_status <> 'active' OR COALESCE(np.communication_enabled, TRUE) = FALSE) LIMIT 1`,
    [recipientUserIds],
  );
  if (result.rowCount || communication.rowCount) {
    throw new HttpError(403, "Message cannot be delivered to one or more recipients", "RECIPIENT_UNAVAILABLE");
  }
}
