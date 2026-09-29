import fs from "fs";
import path from "path";
import { pool } from "./db";

export async function runMigrations(): Promise<void> {
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('phonemail:migrations'))");
  try {
    await lock.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    `);

  const dir = process.env.MIGRATIONS_DIR ?? path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await lock.query("SELECT 1 FROM schema_migrations WHERE id = $1", [
      file,
    ]);
    if ((applied.rowCount ?? 0) > 0) {
      continue;
    }

    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = lock;
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`Applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      // The advisory lock is held until the outer finally block.
    }
  }
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('phonemail:migrations'))").catch(() => undefined);
    lock.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
