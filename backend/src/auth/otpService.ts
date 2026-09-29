import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { HttpError } from "../httpError";
import { normalizePhone, parsePhone, phoneNumberFromPublicIdentity } from "../phone";
import { LocalNotificationAdapter } from "../notifications/mockAdapter";
import type { NotificationChannel, ProviderEvent } from "../notifications/provider";
import { pool } from "../db";
import { TwilioVerifyAdapter } from "./otpProvider";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Challenge = {
  id: string;
  purpose: string;
  phone: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  used: boolean;
  requestId: string;
};

const adapter = new LocalNotificationAdapter();
const challenges = new Map<string, Challenge>();
const webhookEvents = new Set<string>();
const latestSend = new Map<string, number>();

function hashCode(challengeId: string, code: string): string {
  return createHmac("sha256", config.otp.codeHashSecret)
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validatePurpose(purpose: unknown): string {
  if (typeof purpose !== "string" || !/^[a-z][a-z0-9_.-]{1,31}$/.test(purpose)) {
    throw new HttpError(400, "purpose must be a valid identifier", "VALIDATION_ERROR");
  }
  return purpose;
}

export async function requestOtp(input: {
  phone: string;
  country?: string;
  purpose: string;
  channel?: NotificationChannel;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  const parsedPhone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined));
  const phone = parsedPhone.normalized;
  const purpose = validatePurpose(input.purpose);
  const channel = input.channel ?? "sms";
  if (!adapter.capabilities[channel]) {
    throw new HttpError(501, `${channel.toUpperCase()} notifications are not enabled`, "CAPABILITY_UNAVAILABLE");
  }
  const sendKey = `${phone}:${purpose}`;
  const previousSentAt = latestSend.get(sendKey);
  if (previousSentAt !== undefined && now - previousSentAt < config.otp.resendCooldownMs) {
    const retryAfter = Math.ceil((config.otp.resendCooldownMs - (now - previousSentAt)) / 1000);
    throw new HttpError(429, "Please wait before requesting another code", "OTP_RESEND_COOLDOWN", true, { retryAfter: String(retryAfter) });
  }
  const challengeId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  latestSend.set(sendKey, now);
  const request = await adapter.send({ channel, phone: parsedPhone.e164, body: `Your verification code is ${code}` });
  const challenge: Challenge = {
    id: challengeId,
    purpose,
    phone,
    codeHash: hashCode(challengeId, code),
    expiresAt: now + config.otp.ttlMs,
    attempts: 0,
    lastSentAt: now,
    used: false,
    requestId: request.id,
  };
  challenges.set(challengeId, challenge);
  return {
    challengeId,
    purpose,
    phone,
    expiresAt: new Date(challenge.expiresAt).toISOString(),
    resendAfter: new Date(now + config.otp.resendCooldownMs).toISOString(),
    channel,
  };
}

export function getLocalOtpCode(challengeId: string): string | undefined {
  const challenge = challenges.get(challengeId);
  if (!challenge) return undefined;
  const request = adapter.getRequest(challenge.requestId);
  const match = request?.body.match(/\b(\d{6})\b/);
  return match?.[1];
}

export function verifyOtp(input: { challengeId: string; phone: string; country?: string; purpose: string; code: string; now?: number }) {
  const now = input.now ?? Date.now();
  const challenge = challenges.get(input.challengeId);
  const phone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined)).normalized;
  const purpose = validatePurpose(input.purpose);
  if (!challenge || challenge.phone !== phone || challenge.purpose !== purpose) {
    throw new HttpError(400, "Invalid OTP challenge", "OTP_INVALID");
  }
  if (challenge.used) throw new HttpError(400, "OTP has already been used", "OTP_ALREADY_USED");
  if (challenge.expiresAt <= now) throw new HttpError(400, "OTP has expired", "OTP_EXPIRED");
  if (challenge.attempts >= config.otp.maxAttempts) throw new HttpError(429, "Too many OTP attempts", "OTP_ATTEMPTS_EXCEEDED");
  if (!/^\d{6}$/.test(input.code) || !equalHash(challenge.codeHash, hashCode(challenge.id, input.code))) {
    challenge.attempts += 1;
    throw new HttpError(400, "Invalid OTP code", "OTP_INVALID");
  }
  challenge.used = true;
  return { verified: true, challengeId: challenge.id, phone: challenge.phone, purpose: challenge.purpose };
}

export function signProviderWebhook(payload: string, timestamp: string): string {
  return createHmac("sha256", config.otp.webhookSecret).update(`${timestamp}.${payload}`).digest("hex");
}

export async function handleProviderWebhook(payload: string, timestamp: string, signature: string, event: ProviderEvent, now = Date.now()) {
  if (!/^\d+$/.test(timestamp) || Math.abs(now - Number(timestamp)) > config.otp.webhookToleranceMs) {
    throw new HttpError(401, "Webhook timestamp is invalid", "WEBHOOK_INVALID");
  }
  const expected = signProviderWebhook(payload, timestamp);
  if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
    throw new HttpError(401, "Webhook signature is invalid", "WEBHOOK_INVALID");
  }
  if (webhookEvents.has(event.id)) return "duplicate" as const;
  webhookEvents.add(event.id);
  return adapter.handleWebhookEvent(event);
}

export function getNotificationCapabilities() {
  if (config.otpProvider === "twilio") {
    const configured = Boolean(
      config.twilio.verifyServiceSid &&
      (config.twilio.apiKeySid && config.twilio.apiKeySecret || config.twilio.accountSid && config.twilio.authToken),
    );
    return {
      sms: { supported: true, configured, simulated: false, liveTested: false },
      ivr: { supported: true, configured, simulated: false, liveTested: false },
      provider: "twilio_verify",
      localMock: false,
    };
  }
  return {
    sms: { supported: true, configured: false, simulated: true, liveTested: false },
    ivr: { supported: true, configured: false, simulated: false, liveTested: false },
    provider: "local_mock",
    localMock: true,
  };
}

export function resetOtpStateForTests() {
  challenges.clear();
  latestSend.clear();
  webhookEvents.clear();
}

const allowedPurposes = new Set(["signup", "login", "ivr_registration", "phone_change", "phone_change_old"]);

function assertPurpose(purpose: string): string {
  const value = validatePurpose(purpose);
  if (!allowedPurposes.has(value)) throw new HttpError(400, "OTP purpose is not supported", "OTP_PURPOSE_INVALID");
  return value;
}

export type DurableOtpProof = { challengeId: string; phone: string; purpose: string; code: string };
type DurableChallenge = {
  id: string;
  phone_normalized: string;
  purpose: string;
  code_hash: string;
  provider: string;
  provider_request_id: string;
  verification_state: string;
  expires_at: Date;
  attempts: number;
  used_at: Date | null;
};
export type OtpDbClient = { query: (text: string, values?: unknown[]) => Promise<any> };

export async function requestDurableOtp(input: { phone: string; country?: string; purpose: string; channel?: NotificationChannel; ipAddress?: string }) {
  const parsedPhone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined));
  const phone = parsedPhone.normalized;
  const purpose = assertPurpose(input.purpose);
  const channel = input.channel ?? "sms";
  if (channel === "ivr" && config.otpProvider === "local") {
    throw new HttpError(501, "Local mock provider does not implement IVR calls", "CAPABILITY_UNAVAILABLE");
  }
  const ipKey = createHmac("sha256", config.otp.codeHashSecret).update(`otp-ip:${input.ipAddress ?? "unknown"}`).digest("hex");
  const limitClient = await pool.connect();
  try {
    await limitClient.query("BEGIN");
    await limitClient.query("DELETE FROM otp_phone_rate_limits WHERE window_started_at < now() - interval '1 day'");
    await limitClient.query("DELETE FROM otp_ip_rate_limits WHERE window_started_at < now() - interval '1 day'");
    await limitClient.query("DELETE FROM otp_send_limits WHERE last_reserved_at < now() - interval '1 day'");
    const phoneLimit = await limitClient.query(
      `INSERT INTO otp_phone_rate_limits(phone_normalized,window_started_at,request_count)
       VALUES ($1,now(),1)
       ON CONFLICT (phone_normalized) DO UPDATE SET
         window_started_at = CASE WHEN otp_phone_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now() ELSE otp_phone_rate_limits.window_started_at END,
         request_count = CASE WHEN otp_phone_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE otp_phone_rate_limits.request_count + 1 END
       WHERE otp_phone_rate_limits.window_started_at <= now() - interval '15 minutes'
          OR otp_phone_rate_limits.request_count < 10
       RETURNING window_started_at`,
      [phone],
    );
    if (!phoneLimit.rowCount) {
      const current = await limitClient.query<{ window_started_at: Date }>("SELECT window_started_at FROM otp_phone_rate_limits WHERE phone_normalized = $1", [phone]);
      const retryAfter = Math.max(1, Math.ceil((15 * 60_000 - (Date.now() - current.rows[0].window_started_at.getTime())) / 1000));
      throw new HttpError(429, "Too many verification requests; try again later", "OTP_RATE_LIMITED", true, { retryAfter: String(retryAfter) });
    }
    const ipLimit = await limitClient.query(
      `INSERT INTO otp_ip_rate_limits(ip_key,window_started_at,request_count)
       VALUES ($1,now(),1)
       ON CONFLICT (ip_key) DO UPDATE SET
         window_started_at = CASE WHEN otp_ip_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now() ELSE otp_ip_rate_limits.window_started_at END,
         request_count = CASE WHEN otp_ip_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1 ELSE otp_ip_rate_limits.request_count + 1 END
       WHERE otp_ip_rate_limits.window_started_at <= now() - interval '15 minutes'
          OR otp_ip_rate_limits.request_count < 120
       RETURNING window_started_at`,
      [ipKey],
    );
    if (!ipLimit.rowCount) {
      const current = await limitClient.query<{ window_started_at: Date }>("SELECT window_started_at FROM otp_ip_rate_limits WHERE ip_key = $1", [ipKey]);
      const retryAfter = Math.max(1, Math.ceil((15 * 60_000 - (Date.now() - current.rows[0].window_started_at.getTime())) / 1000));
      throw new HttpError(429, "Too many verification requests; try again later", "OTP_RATE_LIMITED", true, { retryAfter: String(retryAfter) });
    }
    const cooldown = await limitClient.query(
      `INSERT INTO otp_send_limits(phone_normalized,purpose,last_reserved_at) VALUES($1,$2,now())
       ON CONFLICT(phone_normalized,purpose) DO UPDATE SET last_reserved_at=now()
       WHERE otp_send_limits.last_reserved_at <= now() - ($3::bigint * interval '1 millisecond')
       RETURNING last_reserved_at`,
      [phone, purpose, config.otp.resendCooldownMs],
    );
    if (!cooldown.rowCount) {
      const current = await limitClient.query<{ last_reserved_at: Date }>(
        "SELECT last_reserved_at FROM otp_send_limits WHERE phone_normalized=$1 AND purpose=$2",
        [phone, purpose],
      );
      const retryAfter = Math.max(1, Math.ceil((config.otp.resendCooldownMs - (Date.now() - current.rows[0].last_reserved_at.getTime())) / 1000));
      throw new HttpError(429, "Please wait before requesting another code", "OTP_RESEND_COOLDOWN", true, { retryAfter: String(retryAfter) });
    }
    await limitClient.query("COMMIT");
  } catch (error) {
    await limitClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    limitClient.release();
  }

  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const provider = config.otpProvider === "twilio" ? "twilio_verify" : "local_mock";
  let providerRequestId: string;
  if (provider === "twilio_verify") {
    providerRequestId = await new TwilioVerifyAdapter().start(parsedPhone.e164, channel === "ivr" ? "call" : "sms");
  } else {
    const request = await adapter.send({ channel, phone: parsedPhone.e164, body: `Your verification code is ${code}` });
    providerRequestId = request.id;
    const sink = process.env.OTP_TEST_SINK_DIR;
    if (sink && config.nodeEnv === "development") {
      await mkdir(sink, { recursive: true });
      await writeFile(join(sink, `${id}.code`), `${code}\n`, { flag: "wx", mode: 0o600 });
    }
  }

  const expiresAt = new Date(Date.now() + config.otp.ttlMs);
  try {
    await pool.query(
      `INSERT INTO otp_challenges
         (id, purpose, phone_normalized, code_hash, expires_at, last_sent_at, provider_request_id, provider)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7)`,
      [id, purpose, phone, hashCode(id, code), expiresAt, providerRequestId, provider],
    );
  } catch (error) {
    throw new HttpError(503, "Verification was sent but could not be safely recorded; request a new code after the cooldown", "OTP_PERSISTENCE_FAILED", true);
  }
  return { challengeId: id, purpose, phone, phoneE164: parsedPhone.e164, country: parsedPhone.country, expiresAt: expiresAt.toISOString(), channel };
}

function validateProofRow(challenge: DurableChallenge | undefined, proof: DurableOtpProof, phone: string, purpose: string) {
  if (!challenge || challenge.phone_normalized !== phone || challenge.purpose !== purpose) {
    throw new HttpError(400, "Invalid OTP challenge", "OTP_INVALID");
  }
  if (challenge.used_at || challenge.verification_state === "used") throw new HttpError(400, "OTP has already been used", "OTP_ALREADY_USED");
  if (challenge.expires_at.getTime() <= Date.now()) throw new HttpError(400, "OTP has expired", "OTP_EXPIRED");
  if (challenge.attempts >= config.otp.maxAttempts || challenge.verification_state === "failed") {
    throw new HttpError(429, "Too many OTP attempts", "OTP_ATTEMPTS_EXCEEDED");
  }
  if (typeof proof.code !== "string" || !/^\d{6}$/.test(proof.code)) throw new HttpError(400, "Invalid OTP code", "OTP_INVALID");
}

async function authorizeExternalProof(proof: DurableOtpProof, operation: string, accountId: string | null) {
  const phone = phoneNumberFromPublicIdentity(proof.phone);
  const purpose = assertPurpose(proof.purpose);
  const client = await pool.connect();
  let challenge: DurableChallenge | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query<DurableChallenge>(
      "SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE",
      [proof.challengeId],
    );
    challenge = result.rows[0];
    validateProofRow(challenge, proof, phone, purpose);
    if (challenge.provider !== "twilio_verify") throw new HttpError(400, "OTP provider does not match the challenge", "OTP_PROVIDER_MISMATCH");
    if (challenge.verification_state === "authorized") {
      const authorization = await client.query(
        `SELECT 1 FROM otp_operation_authorizations
         WHERE challenge_id = $1 AND operation = $2 AND phone_normalized = $3
           AND purpose = $4 AND account_id IS NOT DISTINCT FROM $5::uuid
           AND provider = $6 AND consumed_at IS NULL AND expires_at > now()`,
        [challenge.id, operation, phone, purpose, accountId, challenge.provider],
      );
      if (!authorization.rowCount) throw new HttpError(400, "OTP authorization is bound to another operation", "OTP_OPERATION_MISMATCH");
      if (!equalHash(challenge.code_hash, hashCode(challenge.id, proof.code))) {
        throw new HttpError(400, "Invalid OTP code", "OTP_INVALID");
      }
      await client.query("COMMIT");
      return;
    }
    if (challenge.verification_state !== "issued") {
      throw new HttpError(503, "Provider verification is pending or ambiguous; request a fresh code", "OTP_PROVIDER_AMBIGUOUS", true);
    }
    await client.query(
      "UPDATE otp_challenges SET verification_state = 'checking', verification_started_at = now() WHERE id = $1",
      [challenge.id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  let approved: boolean;
  try {
    approved = await new TwilioVerifyAdapter().check(challenge.provider_request_id, proof.code);
  } catch (error) {
    await pool.query(
      "UPDATE otp_challenges SET verification_state = 'ambiguous' WHERE id = $1 AND verification_state = 'checking'",
      [proof.challengeId],
    ).catch(() => undefined);
    throw error;
  }
  if (!approved) {
    const invalid = await pool.connect();
    try {
      await invalid.query("BEGIN");
      await invalid.query(
        `UPDATE otp_challenges
         SET attempts = attempts + 1,
             verification_state = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'issued' END
         WHERE id = $1 AND verification_state = 'checking'`,
        [proof.challengeId, config.otp.maxAttempts],
      );
      await invalid.query("COMMIT");
    } catch (error) {
      await invalid.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      invalid.release();
    }
    throw new HttpError(400, "Invalid OTP code", "OTP_INVALID");
  }

  const authorized = await pool.connect();
  try {
    await authorized.query("BEGIN");
    await authorized.query(
      `INSERT INTO otp_operation_authorizations
         (challenge_id, operation, phone_normalized, purpose, account_id, provider, expires_at)
       SELECT id,$2,phone_normalized,purpose,$3,provider,expires_at
       FROM otp_challenges WHERE id = $1 AND verification_state = 'checking' AND used_at IS NULL`,
      [proof.challengeId, operation, accountId],
    );
    const updated = await authorized.query(
      "UPDATE otp_challenges SET verification_state = 'authorized', code_hash = $2 WHERE id = $1 AND verification_state = 'checking' AND used_at IS NULL",
      [proof.challengeId, hashCode(proof.challengeId, proof.code)],
    );
    if (!updated.rowCount) throw new HttpError(409, "OTP challenge changed during provider verification", "OTP_STATE_CONFLICT");
    await authorized.query("COMMIT");
  } catch (error) {
    await authorized.query("ROLLBACK").catch(() => undefined);
    throw new HttpError(503, "Provider approved verification but authorization could not be persisted; request a fresh code", "OTP_AUTHORIZATION_PERSISTENCE_FAILED", true);
  } finally {
    authorized.release();
  }
}

export async function withDurableOtpOperation<T>(
  proofs: DurableOtpProof[],
  operation: string,
  accountId: string | null,
  action: (client: OtpDbClient, provenance: string[]) => Promise<T>,
): Promise<T> {
  if (!proofs.length || proofs.length > 2 || new Set(proofs.map((proof) => proof.challengeId)).size !== proofs.length) {
    throw new HttpError(400, "One or two distinct OTP proofs are required", "VALIDATION_ERROR");
  }
  const normalized = proofs.map((proof) => ({ ...proof, phone: phoneNumberFromPublicIdentity(proof.phone), purpose: assertPurpose(proof.purpose) }));
  for (const proof of normalized) {
    const providerResult = await pool.query<{ provider: string }>("SELECT provider FROM otp_challenges WHERE id = $1", [proof.challengeId]);
    if (providerResult.rows[0]?.provider === "twilio_verify") await authorizeExternalProof(proof, operation, accountId);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows: DurableChallenge[] = [];
    for (const proof of normalized) {
      const result = await client.query<DurableChallenge>("SELECT * FROM otp_challenges WHERE id = $1 FOR UPDATE", [proof.challengeId]);
      const challenge = result.rows[0];
      validateProofRow(challenge, proof, proof.phone, proof.purpose);
      if (challenge.provider === "local_mock") {
        if (challenge.verification_state !== "issued" ||
            !equalHash(challenge.code_hash, hashCode(challenge.id, proof.code))) {
          await client.query(
            `UPDATE otp_challenges SET attempts = attempts + 1,
               verification_state = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE verification_state END
             WHERE id = $1`,
            [challenge.id, config.otp.maxAttempts],
          );
          await client.query("COMMIT");
          throw new HttpError(400, "Invalid OTP code", "OTP_INVALID");
        }
      } else if (challenge.provider === "twilio_verify") {
        const authorization = await client.query(
          `SELECT 1 FROM otp_operation_authorizations
           WHERE challenge_id = $1 AND operation = $2 AND phone_normalized = $3
             AND purpose = $4 AND account_id IS NOT DISTINCT FROM $5::uuid
             AND provider = $6 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`,
          [challenge.id, operation, proof.phone, proof.purpose, accountId, challenge.provider],
        );
        if (!authorization.rowCount || challenge.verification_state !== "authorized") {
          throw new HttpError(400, "OTP authorization is bound to another operation", "OTP_OPERATION_MISMATCH");
        }
      } else {
        throw new HttpError(400, "OTP challenge uses an unsupported provider", "OTP_PROVIDER_MISMATCH");
      }
      rows.push(challenge);
    }

    const result = await action(client, rows.map((row) => row.provider));
    for (const row of rows) {
      await client.query(
        "UPDATE otp_challenges SET used_at = now(), verification_state = 'used' WHERE id = $1 AND used_at IS NULL",
        [row.id],
      );
      await client.query("UPDATE otp_operation_authorizations SET consumed_at = now() WHERE challenge_id = $1 AND consumed_at IS NULL", [row.id]);
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyDurableOtp(input: DurableOtpProof & { country?: string }) {
  if (["signup", "login", "phone_change", "phone_change_old", "phone_change_new"].includes(input.purpose)) {
    throw new HttpError(400, "This OTP must be consumed by its authenticated operation", "OTP_PURPOSE_INVALID");
  }
  const phone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined)).normalized;
  return withDurableOtpOperation([{ ...input, phone }], `verify:${input.purpose}`, null, async () => ({
    verified: true,
    challengeId: input.challengeId,
    phone,
    purpose: input.purpose,
  }));
}
