import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Request } from "express";
import { config } from "../config";
import { query } from "../db";
import { HttpError } from "../httpError";
import { parseCookieHeader } from "./cookies";
import type { JwtPayload } from "./jwt";
import type { OtpDbClient } from "./otpService";

export type PhoneChangeRequest = {
  currentPassword?: string;
  newPhone: string;
  country?: string;
  challengeId: string;
  code: string;
  oldChallengeId?: string;
  oldCode?: string;
};

export function requestToken(req: Request): string | undefined {
  const authorization = req.headers.authorization;
  if (authorization?.startsWith("Bearer ")) return authorization.slice("Bearer ".length);
  return parseCookieHeader(req.headers.cookie)[config.sessionCookieName];
}

export function phoneChangeRequestHash(userId: string, sessionId: string, body: PhoneChangeRequest): string {
  const canonical = JSON.stringify([
    userId,
    sessionId,
    body.currentPassword ?? null,
    body.newPhone,
    body.country ?? null,
    body.challengeId,
    body.code,
    body.oldChallengeId ?? null,
    body.oldCode ?? null,
  ]);
  return createHmac("sha256", config.jwtSecret).update(`phone-change-request:${canonical}`).digest("hex");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encryptionKey(): Buffer {
  return createHmac("sha256", config.jwtSecret).update("phone-change-recovery-encryption").digest();
}

export async function savePhoneChangeRecovery(
  client: OtpDbClient,
  input: {
    userId: string;
    sessionId: string;
    idempotencyKey: string;
    originalToken: string;
    request: PhoneChangeRequest;
    response: { user: unknown; token: string; refreshToken: string };
  },
): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(input.response), "utf8"), cipher.final()]);
  await client.query("DELETE FROM phone_change_recoveries WHERE expires_at <= now()");
  await client.query(
    `INSERT INTO phone_change_recoveries
      (user_id, old_session_id, idempotency_key, old_token_hash, request_hash,
       response_ciphertext, response_iv, response_tag, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '15 minutes')`,
    [
      input.userId,
      input.sessionId,
      input.idempotencyKey,
      tokenHash(input.originalToken),
      phoneChangeRequestHash(input.userId, input.sessionId, input.request),
      ciphertext.toString("base64"),
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
    ],
  );
}

export async function recoverPhoneChangeResponse(
  payload: JwtPayload,
  key: string,
  originalToken: string,
  request: PhoneChangeRequest,
): Promise<{ user: unknown; token: string; refreshToken: string } | null> {
  const result = await query<{
    request_hash: string;
    response_ciphertext: string;
    response_iv: string;
    response_tag: string;
  }>(
    `SELECT request_hash, response_ciphertext, response_iv, response_tag
       FROM phone_change_recoveries
      WHERE user_id=$1 AND old_session_id=$2 AND idempotency_key=$3
        AND old_token_hash=$4 AND expires_at > now()`,
    [payload.sub, payload.jti, key, tokenHash(originalToken)],
  );
  if (!result.rowCount) return null;
  const recovery = result.rows[0];
  if (recovery.request_hash !== phoneChangeRequestHash(payload.sub, payload.jti, request)) {
    throw new HttpError(409, "Idempotency key was already used for a different phone change", "IDEMPOTENCY_CONFLICT");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(recovery.response_iv, "base64"));
    decipher.setAuthTag(Buffer.from(recovery.response_tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(recovery.response_ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const response = JSON.parse(plaintext) as { user?: unknown; token?: unknown; refreshToken?: unknown };
    if (!response.user || typeof response.token !== "string" || typeof response.refreshToken !== "string") {
      throw new Error("Invalid recovery payload");
    }
    return { user: response.user, token: response.token, refreshToken: response.refreshToken };
  } catch {
    throw new HttpError(503, "Phone-change recovery is temporarily unavailable", "RECOVERY_UNAVAILABLE", true);
  }
}

export function validPhoneChangeIdempotencyKey(key: string | undefined): key is string {
  return typeof key === "string" && key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(key);
}
