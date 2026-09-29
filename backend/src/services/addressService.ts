import { config } from "../config";
import { pool, query } from "../db";
import { HttpError } from "../httpError";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { recordSecurityEvent } from "./securityEventService";

export type Address = {
  id: string;
  email: string;
  isPrimary: boolean;
  isAlias: boolean;
  isActive: boolean;
  createdAt: string;
};

type AddressRow = {
  id: string;
  email: string;
  is_primary: boolean;
  is_alias: boolean;
  is_active: boolean;
  created_at: Date;
};

function toAddress(row: AddressRow): Address {
  return {
    id: row.id,
    email: row.email,
    isPrimary: row.is_primary,
    isAlias: row.is_alias,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listAddresses(userId: string): Promise<Address[]> {
  const result = await query<AddressRow>(
    `SELECT id, email, is_primary, is_alias, is_active, created_at
     FROM addresses
     WHERE user_id = $1
     ORDER BY is_primary DESC, created_at ASC`,
    [userId]
  );
  return result.rows.map(toAddress);
}

export async function listUserEmails(userId: string): Promise<string[]> {
  const addresses = await listAddresses(userId);
  return addresses.map((a) => a.email);
}

export async function addAlias(userId: string, alias: string): Promise<Address> {
  const local = alias.trim().toLowerCase().replace(new RegExp(`@${config.mailDomain.replace(".", "\\.")}$`), "");
  const reservedNames = new Set([
    "admin", "administrator", "abuse", "billing", "help", "hostmaster", "info",
    "mailer-daemon", "noreply", "no-reply", "postmaster", "root", "security",
    "support", "webmaster",
  ]);
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(local) || /^\d+$/.test(local) || reservedNames.has(local)) {
    throw new HttpError(400, "Aliases must be non-phone names with 3 to 32 characters");
  }
  const email = `${local}@${config.mailDomain}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.alias_identity:${email}`]);
    await lockChangeAccounts(client, [userId]);
    const retiredAlias = await client.query("SELECT 1 FROM retired_aliases WHERE email=$1", [email]);
    const retired = await client.query("SELECT 1 FROM phone_history WHERE address = $1", [email]);
    const existing = await client.query("SELECT 1 FROM addresses WHERE email = $1", [email]);
    if (retiredAlias.rowCount || retired.rowCount || existing.rowCount) {
      throw new HttpError(409, "This address is already in use", "ADDRESS_IN_USE");
    }
    const inserted = await client.query<AddressRow>(
      `INSERT INTO addresses (user_id, email, is_primary, is_alias, is_active)
       VALUES ($1, $2, FALSE, TRUE, TRUE)
       RETURNING id, email, is_primary, is_alias, is_active, created_at`,
      [userId, email]
    );
    const address = inserted.rows[0];
    await client.query(
      `INSERT INTO aliases (user_id, address_id) VALUES ($1, $2)`,
      [userId, address.id]
    );
    await recordChange(client, userId, "address", address.id, "upserted", toAddress(address));
    await recordSecurityEvent(client, {
      userId,
      eventType: "alias_created",
      metadata: { active: true },
      notifyOwner: true,
    });
    await client.query("COMMIT");
    return toAddress(address);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new HttpError(409, "This address is already in use", "ADDRESS_IN_USE");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function setAliasActive(userId: string, addressId: string, active: boolean): Promise<Address> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const result = await client.query<AddressRow>(
      `UPDATE addresses SET is_active=$3
        WHERE id=$1 AND user_id=$2 AND is_alias=TRUE
        RETURNING id,email,is_primary,is_alias,is_active,created_at`,
      [addressId, userId, active],
    );
    if (!result.rows[0]) throw new HttpError(404, "Alias not found", "NOT_FOUND");
    const address = toAddress(result.rows[0]);
    await recordChange(client, userId, "address", addressId, "upserted", address);
    await recordSecurityEvent(client, {
      userId,
      eventType: "alias_activation_changed",
      metadata: { active },
      notifyOwner: true,
    });
    await client.query("COMMIT");
    return address;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteAlias(userId: string, addressId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const initial = await client.query<{ email: string }>(
      "SELECT email FROM addresses WHERE id=$1 AND user_id=$2 AND is_alias=TRUE",
      [addressId, userId],
    );
    if (!initial.rows[0]) throw new HttpError(404, "Alias not found", "NOT_FOUND");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.alias_identity:${initial.rows[0].email}`]);
    await lockChangeAccounts(client, [userId]);
    const current = await client.query<{ email: string }>(
      "SELECT email FROM addresses WHERE id=$1 AND user_id=$2 AND is_alias=TRUE FOR UPDATE",
      [addressId, userId],
    );
    if (!current.rows[0]) throw new HttpError(404, "Alias not found", "NOT_FOUND");
    const retired = await client.query("SELECT 1 FROM retired_aliases WHERE email=$1", [current.rows[0].email]);
    if (retired.rowCount) throw new HttpError(409, "This address is already retired", "ADDRESS_IN_USE");
    await client.query(
      "INSERT INTO retired_aliases(email,retired_by_user_id) VALUES($1,$2)",
      [current.rows[0].email, userId],
    );
    const deleted = await client.query(
      "DELETE FROM addresses WHERE id=$1 AND user_id=$2 AND is_alias=TRUE RETURNING id",
      [addressId, userId],
    );
    if (!deleted.rowCount) throw new HttpError(404, "Alias not found", "NOT_FOUND");
    await recordChange(client, userId, "address", addressId, "deleted", { id: addressId, deleted: true });
    await recordSecurityEvent(client, {
      userId,
      eventType: "alias_deleted",
      metadata: { active: false },
      notifyOwner: true,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
