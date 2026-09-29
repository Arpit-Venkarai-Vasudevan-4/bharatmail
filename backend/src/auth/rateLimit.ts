import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { config } from "../config";
import { pool } from "../db";
import { HttpError } from "../httpError";
import { normalizePhone, phoneNumberFromPublicIdentity } from "../phone";

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 30;
const IP_LIMIT = 120;

function bucketKey(kind: "phone" | "ip", value: string): string {
  return createHmac("sha256", config.otp.codeHashSecret || config.jwtSecret)
    .update(`auth-rate-limit:${kind}:${value}`)
    .digest("hex");
}

export async function authRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  const rawPhone = typeof req.body?.phone === "string" ? req.body.phone : "";
  const country = typeof req.body?.country === "string" ? req.body.country : config.phoneDefaultCountry;
  let phone: string;
  try {
    phone = normalizePhone(rawPhone, country || undefined);
  } catch {
    try {
      phone = `unqualified:${phoneNumberFromPublicIdentity(rawPhone)}`;
    } catch {
      phone = "invalid";
    }
  }
  const buckets = [
    { key: bucketKey("phone", phone), limit: LIMIT },
    { key: bucketKey("ip", req.ip ?? "unknown"), limit: IP_LIMIT },
  ];
  let client: PoolClient | undefined;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("DELETE FROM auth_rate_limits WHERE window_started_at < now() - interval '1 day'");
    let retryAfter = 0;
    for (const bucket of buckets) {
      const result = await client.query<{ window_started_at: Date }>(
        `INSERT INTO auth_rate_limits(bucket_key,window_started_at,request_count)
         VALUES($1,now(),1)
         ON CONFLICT(bucket_key) DO UPDATE SET
           window_started_at = CASE
             WHEN auth_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now()
             ELSE auth_rate_limits.window_started_at
           END,
           request_count = CASE
             WHEN auth_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1
             ELSE auth_rate_limits.request_count + 1
           END
         WHERE auth_rate_limits.window_started_at <= now() - interval '15 minutes'
            OR auth_rate_limits.request_count < $2
         RETURNING window_started_at`,
        [bucket.key, bucket.limit],
      );
      if (result.rowCount) continue;
      const current = await client.query<{ window_started_at: Date }>(
        "SELECT window_started_at FROM auth_rate_limits WHERE bucket_key=$1",
        [bucket.key],
      );
      if (!current.rows[0]) throw new Error("Authentication rate-limit bucket disappeared");
      retryAfter = Math.max(
        retryAfter,
        Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - current.rows[0].window_started_at.getTime())) / 1000)),
      );
    }
    if (retryAfter) {
      await client.query("ROLLBACK");
      inTransaction = false;
      res.setHeader("Retry-After", retryAfter);
      next(new HttpError(429, "Too many authentication attempts; try again later", "RATE_LIMITED", true));
      return;
    }
    await client.query("COMMIT");
    inTransaction = false;
    next();
  } catch (error) {
    if (inTransaction) await client?.query("ROLLBACK").catch(() => undefined);
    const dbCode = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
    if (dbCode.startsWith("08") || dbCode.startsWith("53") || dbCode.startsWith("57") ||
        dbCode === "53300" || dbCode === "57014" ||
        error instanceof Error && (error.message.includes("connect") || error.message.includes("timeout"))) {
      next(new HttpError(503, "Authentication service is temporarily unavailable", "SERVICE_UNAVAILABLE", true));
      return;
    }
    next(error);
  } finally {
    client?.release();
  }
}
