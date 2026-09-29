import { createWriteStream, mkdirSync, statSync, createReadStream, openSync, closeSync, ftruncateSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware";
import { asyncHandler, HttpError } from "../httpError";
import { config } from "../config";
import { pool, query } from "../db";
import { lockChangeAccounts, recordChange } from "../services/stage2Service";

mkdirSync(config.storageDir, { recursive: true });
export const uploadsRouter = Router();
const MAX_FILE = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function truncateFile(path: string, size: number): void {
  const fd = openSync(path, "r+");
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
}

class ByteLimit extends Transform {
  private count = 0;
  constructor(private readonly limit: number) { super(); }
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.count += chunk.length;
    if (this.count > this.limit) {
      callback(new HttpError(413, "Upload exceeds its declared byte limit", "PAYLOAD_TOO_LARGE"));
      return;
    }
    callback(null, chunk);
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function detectMimeType(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
    if (bytes.length >= 5 && bytes.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
    if (bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "PK\u0003\u0004") return "application/zip";
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    return "application/octet-stream";
  } finally {
    await file.close();
  }
}

async function deleteUploadRecord(userId: string, id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const deleted = await client.query("DELETE FROM uploads WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
    if (deleted.rowCount) await recordChange(client, userId, "upload", id, "deleted", { id, deleted: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

uploadsRouter.post("/", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const expected = Number(req.header("X-Expected-Bytes"));
  const filename = (req.header("X-Filename") ?? "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  const mime = "application/octet-stream";
  if (!Number.isInteger(expected) || expected < 1 || expected > MAX_FILE) throw new HttpError(400, "X-Expected-Bytes must be between 1 and 10485760", "VALIDATION_ERROR");
  const id = randomUUID();
  const storageKey = randomUUID();
  const path = join(config.storageDir, storageKey);
  const reserve = await pool.connect();
  try {
    await reserve.query("BEGIN");
    await lockChangeAccounts(reserve, [userId]);
    await reserve.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.upload_quota:${userId}`]);
    const usage = await reserve.query<{ bytes: string; active: string }>(
      "SELECT COALESCE(SUM(expected_bytes), 0)::bigint AS bytes, COUNT(*) FILTER (WHERE status = 'staged')::int AS active FROM uploads WHERE user_id = $1 AND status IN ('staged','ready')",
      [userId],
    );
    if (Number(usage.rows[0]?.active ?? 0) >= config.uploadConcurrentLimit) {
      throw new HttpError(429, "Too many active uploads", "UPLOAD_CONCURRENCY_LIMIT", true);
    }
    if (Number(usage.rows[0]?.bytes ?? 0) + expected > config.uploadQuotaBytes) {
      throw new HttpError(413, "Upload quota exceeded", "UPLOAD_QUOTA_EXCEEDED");
    }
    await reserve.query(
      `INSERT INTO uploads (id,user_id,storage_key,filename,mime_type,expected_bytes,status,offset_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,'staged',0)`,
      [id, userId, storageKey, filename, mime, expected],
    );
    await recordChange(reserve, userId, "upload", id, "upserted", { id, filename, mimeType: mime, expectedBytes: expected, status: "staged", offsetBytes: 0 });
    await reserve.query("COMMIT");
  } catch (error) {
    await reserve.query("ROLLBACK").catch(() => undefined);
    reserve.release();
    throw error;
  }
  reserve.release();
  if (req.header("X-Upload-Mode") === "resumable") {
    try {
      const fd = openSync(path, "wx");
      ftruncateSync(fd, 0);
      closeSync(fd);
    } catch (error) {
      await removeFile(path);
      await deleteUploadRecord(userId, id);
      throw error;
    }
    res.status(201).json({ upload: { id, filename, mimeType: mime, expectedBytes: expected, status: "staged", offset: 0 } });
    return;
  }
  let completedSize = 0;
  try {
    await pipeline(req, new ByteLimit(expected), createWriteStream(path, { flags: "wx" }));
    const size = statSync(path).size;
    const detectedMime = await detectMimeType(path);
    completedSize = size;
    if (size !== expected || size > MAX_FILE) {
      res.status(400);
      throw new HttpError(400, "Uploaded byte count does not match expected size", "UPLOAD_SIZE_MISMATCH");
    }
    const complete = await pool.connect();
    try {
      await complete.query("BEGIN");
      await lockChangeAccounts(complete, [userId]);
      await complete.query("UPDATE uploads SET size_bytes = $2, offset_bytes = $2, status = 'ready', mime_type = $4 WHERE id = $1 AND user_id = $3", [id, size, userId, detectedMime]);
      await recordChange(complete, userId, "upload", id, "upserted", { id, filename, mimeType: detectedMime, sizeBytes: size, status: "ready", scannerState: "unscanned", offsetBytes: size });
      await complete.query("COMMIT");
    } catch (error) {
      await complete.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      complete.release();
    }
  } catch (error) {
    await removeFile(path);
    await deleteUploadRecord(userId, id);
    throw error;
  }
  res.status(201).json({ upload: { id, filename, mimeType: await detectMimeType(path), sizeBytes: completedSize, status: "ready", scannerState: "unscanned", offset: completedSize } });
}));

uploadsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "upload id must be a UUID", "VALIDATION_ERROR");
  const offset = Number(req.header("X-Upload-Offset"));
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "X-Upload-Offset is required", "VALIDATION_ERROR");
  const metadata = await query<{ storage_key: string; expected_bytes: number; offset_bytes: number; status: string }>(
    "SELECT storage_key, expected_bytes, offset_bytes, status FROM uploads WHERE id = $1 AND user_id = $2",
    [req.params.id, userId],
  );
  const initial = metadata.rows[0];
  if (!initial || initial.status !== "staged") throw new HttpError(404, "Staged upload not found", "NOT_FOUND");
  if (offset !== initial.offset_bytes) throw new HttpError(409, "Upload offset conflict", "UPLOAD_OFFSET_CONFLICT");
  const remaining = initial.expected_bytes - offset;
  if (remaining < 0) throw new HttpError(409, "Upload metadata is invalid", "UPLOAD_OFFSET_CONFLICT");
  const path = join(config.storageDir, initial.storage_key);
  const tempPath = `${path}.${randomUUID()}.chunk`;
  let destinationTouched = false;
  try {
    await pipeline(req, new ByteLimit(remaining), createWriteStream(tempPath, { flags: "wx" }));
    const chunkSize = statSync(tempPath).size;
    if (chunkSize > remaining) throw new HttpError(413, "Upload exceeds expected size", "PAYLOAD_TOO_LARGE");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [req.params.id]);
      await lockChangeAccounts(client, [userId]);
      const locked = await client.query<{ expected_bytes: number; offset_bytes: number; status: string; mime_type: string; scanner_state: string }>(
        "SELECT expected_bytes, offset_bytes, status, mime_type, scanner_state FROM uploads WHERE id = $1 AND user_id = $2 FOR UPDATE",
        [req.params.id, userId],
      );
      const current = locked.rows[0];
      if (!current || current.status !== "staged" || current.offset_bytes !== offset) {
        throw new HttpError(409, "Upload offset conflict", "UPLOAD_OFFSET_CONFLICT");
      }
      const committedSize = statSync(path).size;
      if (committedSize < offset) {
        throw new HttpError(409, "Stored upload is shorter than its committed offset", "UPLOAD_STORAGE_MISMATCH");
      }
      if (committedSize > offset) truncateFile(path, offset);
      destinationTouched = true;
      await pipeline(createReadStream(tempPath), createWriteStream(path, { flags: "r+", start: offset }));
      const size = offset + chunkSize;
      const status = size === current.expected_bytes ? "ready" : "staged";
      const detectedMime = status === "ready" ? await detectMimeType(path) : null;
      await client.query("UPDATE uploads SET offset_bytes = $3, size_bytes = $3, status = $4, mime_type = COALESCE($5,mime_type), scanner_state = CASE WHEN $4='ready' THEN 'unscanned' ELSE scanner_state END WHERE id = $1 AND user_id = $2", [req.params.id, userId, size, status, detectedMime]);
      await recordChange(client, userId, "upload", req.params.id, "upserted", { id: req.params.id, status, offsetBytes: size, expectedBytes: current.expected_bytes, ...(detectedMime ? { mimeType: detectedMime, scannerState: "unscanned" } : {}) });
      await client.query("COMMIT");
      res.json({
        upload: {
          id: req.params.id,
          status,
          offset: size,
          expectedBytes: current.expected_bytes,
          mimeType: detectedMime ?? current.mime_type,
          scannerState: status === "ready" ? "unscanned" : current.scanner_state,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (destinationTouched) {
        try {
          truncateFile(path, offset);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Upload chunk failed and the uncommitted file tail could not be removed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    throw error;
  } finally {
    await removeFile(tempPath).catch(() => undefined);
  }
}));

uploadsRouter.get("/:id/status", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "upload id must be a UUID", "VALIDATION_ERROR");
  const result = await query<{ id: string; expected_bytes: number; offset_bytes: number; status: string; scanner_state: string; expires_at: Date }>(
    `SELECT id,expected_bytes,offset_bytes,status,scanner_state,expires_at
       FROM uploads WHERE id=$1 AND user_id=$2`,
    [req.params.id, userId],
  );
  const upload = result.rows[0];
  if (!upload) throw new HttpError(404, "Upload not found", "NOT_FOUND");
  res.json({
    upload: {
      id: upload.id,
      expectedBytes: upload.expected_bytes,
      offset: upload.offset_bytes,
      status: upload.status,
      scannerState: upload.scanner_state,
      expiresAt: upload.expires_at.toISOString(),
    },
  });
}));

uploadsRouter.get("/:id", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "attachment id must be a UUID", "VALIDATION_ERROR");
  const result = await query<{ storage_key: string; filename: string; mime_type: string; size_bytes: number; status: string }>(
    `SELECT u.storage_key, u.filename, u.mime_type, u.size_bytes, u.status
       FROM uploads u
      WHERE u.status = 'ready' AND (
        (u.id = $1 AND u.user_id = $2) OR EXISTS (
          SELECT 1 FROM attachments a
          JOIN messages m ON m.id = a.message_id
          JOIN message_recipients mr ON mr.message_id = m.id
          WHERE a.id = $1 AND a.storage_key = u.storage_key
            AND mr.recipient_user_id = $2 AND m.folder <> 'drafts'
        ) OR EXISTS (
          SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
          WHERE a.id = $1 AND a.storage_key = u.storage_key AND m.sender_user_id = $2
        )
      )`, [req.params.id, userId]);
  const file = result.rows[0];
  if (!file || file.status !== "ready") throw new HttpError(404, "Attachment not found", "NOT_FOUND");
  const path = join(config.storageDir, file.storage_key);
  const size = statSync(path).size;
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", file.mime_type);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename.replace(/["\\\r\n]/g, "_")}"`);
  if (!range) {
    res.setHeader("Content-Length", size);
    createReadStream(path).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    res.status(416).setHeader("Content-Range", `bytes */${size}`);
    throw new HttpError(416, "Invalid range", "INVALID_RANGE");
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      throw new HttpError(416, "Invalid range", "INVALID_RANGE");
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      res.status(416).setHeader("Content-Range", `bytes */${size}`);
      throw new HttpError(416, "Range is outside the file", "INVALID_RANGE");
    }
    end = Math.min(end, size - 1);
  }
  res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  createReadStream(path, { start, end }).pipe(res);
}));

uploadsRouter.post("/:id/attach", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "upload id must be a UUID", "VALIDATION_ERROR");
  const messageId = req.body?.messageId;
  if (typeof messageId !== "string") throw new HttpError(400, "messageId is required", "VALIDATION_ERROR");
  const result = await query<{ storage_key: string; filename: string; mime_type: string; size_bytes: number; scanner_state: string }>(
    `SELECT u.storage_key, u.filename, u.mime_type, u.size_bytes, u.scanner_state
       FROM uploads u
      WHERE u.id = $1 AND u.user_id = $2 AND u.status = 'ready'
        AND EXISTS (SELECT 1 FROM messages m WHERE m.id = $3 AND m.sender_user_id = $2)`,
    [req.params.id, userId, messageId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Upload or owned message not found", "NOT_FOUND");
  const file = result.rows[0];
  await query(`INSERT INTO attachments (message_id, filename, mime_type, size_bytes, storage_key, scanner_state) VALUES ($1,$2,$3,$4,$5,$6)`,
    [messageId, file.filename, file.mime_type, file.size_bytes, file.storage_key, file.scanner_state]);
  res.status(201).json({ attachment: { messageId, filename: file.filename, mimeType: file.mime_type, sizeBytes: file.size_bytes, scanStatus: file.scanner_state } });
}));
