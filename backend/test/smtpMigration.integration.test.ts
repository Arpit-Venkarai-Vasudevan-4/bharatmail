import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import test from "node:test";
import { smtpDemoIntegrationTargets } from "./smtpIntegrationTarget";

const { databaseUrl } = smtpDemoIntegrationTargets();
const migrationsDirectory = join(process.cwd(), "migrations");

async function apply(client: Client, migrations: string[]) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  for (const name of migrations) {
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

async function assertFinalSchema(client: Client, migrationCount: number) {
  const applied = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM schema_migrations");
  assert.equal(applied.rows[0].count, migrationCount);
  for (const table of ["security_notifications", "smtp_message_deliveries", "inbound_mail_dedup"]) {
    const result = await client.query<{ exists: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS exists",
      [`public.${table}`],
    );
    assert.equal(result.rows[0].exists, true, `${table} must exist after all migrations`);
  }
}

test("SMTP schema migrates on a fresh database and from the pre-029 upgrade point", { timeout: 45_000 }, async () => {
  const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const additiveMigration = "029_security_event_notifications.sql";
  assert.ok(migrations.includes(additiveMigration));
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  const databases = [`phonemail_smtp_fresh_${suffix}`, `phonemail_smtp_upgrade_${suffix}`];
  const migrationUrl = new URL(databaseUrl);
  const adminUrl = new URL(migrationUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 5000, statement_timeout: 10_000 });

  await admin.connect();
  try {
    for (const database of databases) await admin.query(`CREATE DATABASE "${database}"`);
    const freshUrl = new URL(migrationUrl);
    freshUrl.pathname = `/${databases[0]}`;
    const fresh = new Client({ connectionString: freshUrl.toString(), connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
    try {
      await fresh.connect();
      await apply(fresh, migrations);
      await assertFinalSchema(fresh, migrations.length);
    } finally {
      await fresh.end();
    }

    const upgradeUrl = new URL(migrationUrl);
    upgradeUrl.pathname = `/${databases[1]}`;
    const upgrade = new Client({ connectionString: upgradeUrl.toString(), connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
    try {
      await upgrade.connect();
      const prior = migrations.filter((name) => name < additiveMigration);
      await apply(upgrade, prior);
      assert.equal((await upgrade.query("SELECT to_regclass('public.security_notifications') AS table_name")).rows[0].table_name, null);
      await apply(upgrade, migrations);
      await assertFinalSchema(upgrade, migrations.length);
    } finally {
      await upgrade.end();
    }
    console.log(`PASS fresh and pre-029 upgrade migrations (${migrations.length} total migrations)`);
  } finally {
    for (const database of databases) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin.end();
  }
});
