import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";

const { databaseUrl } = integrationTargets();
const migrationsDirectory = join(process.cwd(), "migrations");

async function apply(client: Client, migrationNames: string[]) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  for (const name of migrationNames) {
    if ((await client.query("SELECT 1 FROM schema_migrations WHERE id=$1", [name])).rowCount) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(join(migrationsDirectory, name), "utf8"));
      await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [name]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function assertNotificationsTable(client: Client) {
  const result = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.security_notifications') IS NOT NULL AS exists",
  );
  assert.equal(result.rows[0].exists, true);
  const auditColumns = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='public' AND table_name='account_audit_events'`,
  );
  assert.ok(auditColumns.rows[0].count > 0);
}

async function assertE2eeSchema(client: Client) {
  for (const table of ["e2ee_key_challenges", "e2ee_public_keys", "e2ee_messages", "e2ee_drafts"]) {
    assert.equal(
      (await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [`public.${table}`])).rows[0].exists,
      true,
      `missing ${table}`,
    );
  }
  assert.equal(
    (await client.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='messages' AND column_name='content_format') AS exists`,
    )).rows[0].exists,
    true,
  );
}

async function main() {
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const migrationUrl = new URL(databaseUrl);
  const adminUrl = new URL(migrationUrl);
  adminUrl.pathname = "/postgres";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const databases = [`phonemail_fresh_${suffix}`, `phonemail_upgrade_${suffix}`];
  const admin = new Client({ connectionString: adminUrl.toString() });

  await admin.connect();
  try {
    for (const database of databases) {
      await admin.query(`CREATE DATABASE "${database}"`);
    }
    const freshUrl = new URL(migrationUrl);
    freshUrl.pathname = `/${databases[0]}`;
    const fresh = new Client({ connectionString: freshUrl.toString() });
    try {
      await fresh.connect();
      await apply(fresh, migrations);
      assert.equal((await fresh.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count, migrations.length);
      await assertNotificationsTable(fresh);
      await assertE2eeSchema(fresh);
    } finally {
      await fresh.end();
    }

    const upgradeUrl = new URL(migrationUrl);
    upgradeUrl.pathname = `/${databases[1]}`;
    const upgrade = new Client({ connectionString: upgradeUrl.toString() });
    try {
      await upgrade.connect();
      const additiveMigration = "032_e2ee_qr.sql";
      const prior = migrations.filter((name) => name < additiveMigration);
      assert.ok(migrations.includes(additiveMigration));
      await apply(upgrade, prior);
      assert.equal((await upgrade.query("SELECT to_regclass('public.e2ee_public_keys') AS table_name")).rows[0].table_name, null);
      await apply(upgrade, migrations);
      assert.equal((await upgrade.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count, migrations.length);
      await assertNotificationsTable(upgrade);
      await assertE2eeSchema(upgrade);
    } finally {
      await upgrade.end();
    }
    console.log(`Fresh migration: ${migrations.length} migrations applied; pre-032 upgrade: ${migrations.length - 1} then additive migration 032; E2EE tables/columns verified.`);
  } finally {
    for (const database of databases) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration compatibility verification failed");
  process.exitCode = 1;
});
