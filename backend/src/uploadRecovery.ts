import { opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pool, query } from "./db";
import { lockChangeAccounts, recordChange } from "./services/stage2Service";

type UploadRow = { id: string; user_id: string; storage_key: string; status: string };

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function cleanupUploads(storageDir: string): Promise<{ expired: number; orphaned: number }> {
  const expired = await query<UploadRow>(
    `SELECT id, user_id, storage_key, status FROM uploads
      WHERE status IN ('staged','expired') AND expires_at <= now()
      ORDER BY expires_at,id LIMIT 500`,
  );
  let expiredCount = 0;
  for (const upload of expired.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [upload.id]);
      await lockChangeAccounts(client, [upload.user_id]);
      const current = await client.query<{ status: string; referenced: boolean }>(
        `SELECT u.status, EXISTS(SELECT 1 FROM attachments a WHERE a.storage_key = u.storage_key) AS referenced
           FROM uploads u WHERE u.id = $1 AND u.user_id = $2 AND u.expires_at <= now() FOR UPDATE`,
        [upload.id, upload.user_id],
      );
      let removeStoredFile = current.rows[0]?.status === "expired" && !current.rows[0].referenced;
      const changed = await client.query(
        `UPDATE uploads SET status = 'expired'
          WHERE id = $1 AND user_id = $2 AND status = 'staged' AND expires_at <= now()
          RETURNING id`,
        [upload.id, upload.user_id],
      );
      if (changed.rowCount) {
        removeStoredFile = !current.rows[0]?.referenced;
        await recordChange(client, upload.user_id, "upload", upload.id, "deleted", { id: upload.id, deleted: true, reason: "expired" });
      }
      const removed = await client.query(
        "DELETE FROM uploads WHERE id=$1 AND user_id=$2 AND status='expired' RETURNING id",
        [upload.id, upload.user_id],
      );
      await client.query("COMMIT");
      if (removeStoredFile) {
        await removeIfPresent(join(storageDir, upload.storage_key));
      }
      if (removed.rowCount) expiredCount++;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  let orphaned = 0;
  const directory = await opendir(storageDir);
  let candidates: string[] = [];
  const cleanupBatch = async () => {
    if (!candidates.length) return;
    const known = await query<{ storage_key: string }>(
      `SELECT storage_key FROM uploads WHERE storage_key=ANY($1::text[])
       UNION
       SELECT storage_key FROM attachments WHERE storage_key=ANY($1::text[])`,
      [candidates],
    );
    const knownKeys = new Set(known.rows.map((row) => row.storage_key));
    const chunkParents = candidates
      .map((name) => /^([0-9a-f-]{36})\.[0-9a-f-]{36}\.chunk$/i.exec(name)?.[1])
      .filter((name): name is string => Boolean(name));
    const activeChunks = chunkParents.length
      ? await query<{ storage_key: string }>(
          "SELECT storage_key FROM uploads WHERE storage_key=ANY($1::text[]) AND status='staged' AND expires_at>now()",
          [chunkParents],
        )
      : { rows: [] as { storage_key: string }[] };
    const activeChunkKeys = new Set(activeChunks.rows.map((row) => row.storage_key));
    for (const name of candidates) {
      const parent = /^([0-9a-f-]{36})\.[0-9a-f-]{36}\.chunk$/i.exec(name)?.[1];
      if (!knownKeys.has(name) && !(parent && activeChunkKeys.has(parent))) {
        await removeIfPresent(join(storageDir, name));
        orphaned++;
      }
    }
    candidates = [];
  };
  for await (const file of directory) {
    if (!file.isFile()) continue;
    candidates.push(file.name);
    if (candidates.length >= 500) await cleanupBatch();
  }
  await cleanupBatch();
  return { expired: expiredCount, orphaned };
}
