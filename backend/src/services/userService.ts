import { requirePasswordAuth } from "../auth/registry";
import { signToken } from "../auth/jwt";
import { config } from "../config";
import { pool, query } from "../db";
import { HttpError } from "../httpError";
import {
  emailFromPhone,
  lockPhoneIdentities,
  normalizePhone,
  parsePhone,
  phoneNumberFromPublicIdentity,
  type ParsedPhone,
} from "../phone";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { withDurableOtpOperation, type DurableOtpProof } from "../auth/otpService";
import { savePhoneChangeRecovery, type PhoneChangeRequest } from "../auth/phoneChangeRecovery";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { recordFailedAuthentication, recordSecurityEvent } from "./securityEventService";

export type SignupChannel = "mobile" | "web" | "portal" | "ivr" | "sms";
const CURRENT_TERMS_VERSION = "mvp-1";
type AuthResult = { user: PublicUser; token: string; refreshToken: string };

export type PublicUser = {
  id: string;
  phone: string;
  phoneE164: string | null;
  phoneCountry: string | null;
  phoneIdentityNeedsCountry: boolean;
  email: string;
  displayName: string | null;
  language: string;
  profilePictureUrl: string | null;
  signupChannel: SignupChannel;
  hasMobileApp: boolean;
};

type UserRow = {
  id: string;
  phone_normalized: string;
  phone_e164: string | null;
  phone_country: string | null;
  password_hash: string | null;
  display_name: string | null;
  language: string;
  profile_picture_url: string | null;
  signup_channel: SignupChannel;
  has_mobile_app: boolean;
};

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    phone: row.phone_normalized,
    phoneE164: row.phone_e164,
    phoneCountry: row.phone_country,
    phoneIdentityNeedsCountry: row.phone_e164 === null,
    email: emailFromPhone(row.phone_normalized, config.mailDomain),
    displayName: row.display_name,
    language: row.language,
    profilePictureUrl: row.profile_picture_url,
    signupChannel: row.signup_channel,
    hasMobileApp: row.has_mobile_app,
  };
}

async function rejectAmbiguousLegacyIdentity(client: { query: (text: string, values?: any[]) => Promise<any> }, phone: ParsedPhone): Promise<void> {
  const collision = await client.query(
    `SELECT 1 FROM users WHERE phone_country IS NULL AND phone_normalized=$1
     UNION ALL
     SELECT 1 FROM phone_history WHERE phone_country IS NULL AND phone_normalized=$1
     LIMIT 1`,
    [phone.nationalNumber],
  );
  if (collision.rowCount) {
    throw new HttpError(409, "This number is ambiguous with a legacy PhoneMail identity; authenticate the existing account or contact support", "LEGACY_IDENTITY_AMBIGUOUS");
  }
}

export async function registerUser(input: {
  phone: string;
  country?: string;
  password: string;
  displayName?: string;
  language?: string;
  signupChannel?: SignupChannel;
  termsAccepted?: boolean;
  termsVersion?: string;
}): Promise<AuthResult> {
  const provider = requirePasswordAuth();
  const parsedPhone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined));
  const phone = parsedPhone.normalized;
  if (input.displayName !== undefined && (typeof input.displayName !== "string" || input.displayName.trim().length > 100)) throw new HttpError(400, "displayName must be at most 100 characters", "VALIDATION_ERROR");
  if (input.language !== undefined && (typeof input.language !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.language))) throw new HttpError(400, "language is invalid", "VALIDATION_ERROR");
  if (input.signupChannel !== undefined && !new Set<SignupChannel>(["mobile", "web", "portal", "ivr"]).has(input.signupChannel)) throw new HttpError(400, "signupChannel is invalid", "VALIDATION_ERROR");
  if (input.termsAccepted !== true) throw new HttpError(400, "Terms acceptance is required", "VALIDATION_ERROR");
  if (input.termsVersion !== undefined && input.termsVersion !== CURRENT_TERMS_VERSION) throw new HttpError(400, "Terms version is no longer current", "TERMS_VERSION_MISMATCH");
  const displayName = input.displayName?.trim().slice(0, 100) ?? null;
  const language = input.language ?? "en";
  const email = emailFromPhone(phone, config.mailDomain);
  let passwordHash: string | null;
  try {
    passwordHash = await provider.prepareSecret(input.password);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid password";
    throw new HttpError(400, message);
  }
  if (!passwordHash) {
    throw new HttpError(500, "Could not store password");
  }

  const channel = input.signupChannel ?? "mobile";
  const hasMobileApp = channel === "mobile";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockPhoneIdentities(client, [phone]);
    await rejectAmbiguousLegacyIdentity(client, parsedPhone);
    const retired = await client.query("SELECT 1 FROM phone_history WHERE phone_normalized = $1 OR address = $2", [phone, email]);
    if (retired.rowCount) throw new HttpError(409, "This phone number is unavailable", "PHONE_IN_USE");
    const existing = await client.query("SELECT 1 FROM users WHERE phone_normalized = $1", [
      phone,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      throw new HttpError(409, "An account already exists for this phone number");
    }

    const inserted = await client.query<UserRow>(
      `INSERT INTO users (phone_normalized, phone_e164, phone_country, password_hash, display_name, language, signup_channel, has_mobile_app, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       RETURNING *`,
      [
        phone,
        parsedPhone.e164,
        (parsedPhone.country ?? input.country?.toUpperCase() ?? config.phoneDefaultCountry) || null,
        passwordHash,
        displayName,
        language,
        channel,
        hasMobileApp,
        CURRENT_TERMS_VERSION,
      ]
    );
    const user = inserted.rows[0];

    await client.query(
      `INSERT INTO addresses (user_id, email, is_primary, is_alias)
       VALUES ($1, $2, TRUE, FALSE)`,
      [user.id, email]
    );
    const session = await issueSession(client, user);
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "account_created",
      metadata: { authMethod: "password", channel },
      notifyOwner: true,
    });

    await client.query("COMMIT");
    return {
      user: toPublic(user),
      ...session,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new HttpError(409, "An account already exists for this phone number", "CONFLICT");
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function loginUser(input: {
  phone: string;
  country?: string;
  password: string;
}): Promise<AuthResult> {
  const provider = requirePasswordAuth();
  const country = input.country ?? (config.phoneDefaultCountry || undefined);
  const phone = country || input.phone.trim().startsWith("+") || input.phone.trim().startsWith("00")
    ? normalizePhone(input.phone, country)
    : phoneNumberFromPublicIdentity(input.phone);

  const result = await query<UserRow>(
    "SELECT * FROM users WHERE phone_normalized = $1 AND account_status='active'",
    [phone]
  );
  const user = result.rows[0];
  if (!user) {
    throw new HttpError(401, "Invalid phone number or password");
  }
  if (!user.password_hash) {
    await recordFailedAuthentication(user.id, "password");
    throw new HttpError(401, "Invalid phone number or password");
  }

  const ok = await provider.verify(
    {
      id: user.id,
      phoneNormalized: user.phone_normalized,
      passwordHash: user.password_hash,
    },
    input.password
  );
  if (!ok) {
    await recordFailedAuthentication(user.id, "password");
    throw new HttpError(401, "Invalid phone number or password");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await issueSession(client, user);
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "login_succeeded",
      metadata: { authMethod: "password" },
      notifyOwner: true,
    });
    await client.query("COMMIT");
    return { user: toPublic(user), ...session };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function logoutUser(userId: string, sessionId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revoked = await client.query(
      "DELETE FROM sessions WHERE family_id=(SELECT family_id FROM sessions WHERE id=$1 AND user_id=$2) RETURNING id",
      [sessionId, userId],
    );
    if (revoked.rowCount) {
      await recordSecurityEvent(client, { userId, eventType: "logout", metadata: { authMethod: "session" } });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateUser(
  id: string,
  input: { displayName?: string; language?: string }
): Promise<PublicUser> {
  if (input.displayName !== undefined && (typeof input.displayName !== "string" || input.displayName.trim().length > 100)) {
    throw new HttpError(400, "displayName must be at most 100 characters");
  }

  if (input.language !== undefined && (typeof input.language !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.language))) {
    throw new HttpError(400, "language must be a valid language code");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [id]);
    const result = await client.query<UserRow>(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         language = COALESCE($3, language),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.displayName === undefined ? null : input.displayName.trim(), input.language ?? null]
    );
    if (!result.rows[0]) throw new HttpError(404, "User not found");
    await recordChange(client, id, "account", id, "upserted", { displayName: result.rows[0].display_name, language: result.rows[0].language });
    await client.query("COMMIT");
    return toPublic(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateProfilePicture(userId: string, uploadId: string | null): Promise<PublicUser> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    let upload: { storage_key: string; mime_type: string; size_bytes: number } | undefined;
    if (uploadId !== null) {
      const result = await client.query<{ storage_key: string; mime_type: string; size_bytes: number }>(
        `SELECT storage_key,mime_type,size_bytes FROM uploads
          WHERE id=$1 AND user_id=$2 AND status='ready' AND expires_at > now()
          FOR UPDATE`,
        [uploadId, userId],
      );
      upload = result.rows[0];
      if (!upload || upload.size_bytes < 1 || upload.size_bytes > 2 * 1024 * 1024) {
        throw new HttpError(400, "Profile image must be an owned, ready image of at most 2 MiB", "PROFILE_IMAGE_INVALID");
      }
      const descriptor = openSync(join(config.storageDir, upload.storage_key), "r");
      const header = Buffer.alloc(12);
      let bytesRead = 0;
      try {
        bytesRead = readSync(descriptor, header, 0, header.length, 0);
      } finally {
        closeSync(descriptor);
      }
      const signature = header.subarray(0, bytesRead);
      const actualType = signature.length >= 8 && signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
          ? "image/jpeg"
          : signature.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/)
            ? "image/gif"
            : null;
      if (!actualType || actualType !== upload.mime_type) {
        throw new HttpError(400, "Profile image content does not match a supported image type", "PROFILE_IMAGE_INVALID");
      }
    }
    const result = await client.query<UserRow>(
      `UPDATE users SET profile_picture_upload_id=$2,
         profile_picture_url=$3, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [userId, uploadId, uploadId ? `/api/users/${userId}/profile-picture` : null],
    );
    if (!result.rows[0]) throw new HttpError(404, "User not found", "NOT_FOUND");
    const user = toPublic(result.rows[0]);
    await recordChange(client, userId, "account", userId, "upserted", { profilePictureUrl: user.profilePictureUrl });
    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getUserById(id: string): Promise<PublicUser> {
  const result = await query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  const user = result.rows[0];
  if (!user) {
    throw new HttpError(404, "User not found");
  }

  return toPublic(user);
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function refreshEncryptionKey(): Buffer {
  return createHash("sha256").update(`phonemail-refresh-retry:${config.jwtSecret}`).digest();
}

function encryptRefreshResponse(response: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", refreshEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(response, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${ciphertext.toString("hex")}`;
}

function decryptRefreshResponse(value: string): AuthResult {
  const [ivHex, tagHex, ciphertextHex] = value.split(".");
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error("Stored session retry response is malformed");
  const decipher = createDecipheriv("aes-256-gcm", refreshEncryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as AuthResult;
}

async function issueSession(client: { query: (text: string, values?: any[]) => Promise<any> }, user: UserRow) {
  const sessionId = randomUUID();
  const refreshToken = randomBytes(32).toString("base64url");
  await client.query(
    `INSERT INTO sessions(id,family_id,user_id,expires_at,refresh_token_hash)
     VALUES($1,$1,$2,now()+$3::interval,$4)`,
    [sessionId, user.id, config.sessionRenewalTtl, hashRefreshToken(refreshToken)],
  );
  await client.query(
    "INSERT INTO session_refresh_tokens(token_hash,session_id,generation) VALUES($1,$2,0)",
    [hashRefreshToken(refreshToken), sessionId],
  );
  return {
    token: signToken({ sub: user.id, phone: user.phone_normalized, jti: sessionId }),
    refreshToken,
  };
}

export async function renewSession(refreshToken: string): Promise<AuthResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) {
    throw new HttpError(401, "Refresh credential is invalid", "UNAUTHORIZED");
  }
  const presentedHash = hashRefreshToken(refreshToken);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const result = await client.query<UserRow & {
      session_id: string;
      family_id: string;
      expires_at: Date;
      refresh_token_hash: string;
      account_status: string;
      generation: number;
      used_at: Date | null;
      retry_until: Date | null;
      retry_ciphertext: string | null;
      is_current: boolean;
    }>(
      `SELECT s.id AS session_id,s.family_id,s.expires_at,s.refresh_token_hash,
              u.*,u.account_status,rt.generation,rt.used_at,rt.retry_until,rt.retry_ciphertext,
              (s.refresh_token_hash=rt.token_hash) AS is_current
         FROM session_refresh_tokens rt
         JOIN sessions s ON s.id=rt.session_id
         JOIN users u ON u.id=s.user_id
        WHERE rt.token_hash=$1
        FOR UPDATE OF s,rt`,
      [presentedHash],
    );
    const session = result.rows[0];
    if (!session) {
      await client.query("COMMIT");
      transactionOpen = false;
      throw new HttpError(401, "Refresh credential is invalid", "UNAUTHORIZED");
    }
    if (session.expires_at.getTime() <= Date.now() || session.account_status !== "active") {
      await client.query("DELETE FROM sessions WHERE family_id=$1", [session.family_id]);
      await client.query("COMMIT");
      transactionOpen = false;
      throw new HttpError(401, "Session renewal has expired", "UNAUTHORIZED");
    }

    if (!session.is_current) {
      if (session.retry_until && session.retry_until.getTime() > Date.now() &&
          session.retry_ciphertext) {
        const retryResponse = decryptRefreshResponse(session.retry_ciphertext);
        await client.query("COMMIT");
        transactionOpen = false;
        return retryResponse;
      }
      await client.query("DELETE FROM sessions WHERE family_id=$1", [session.family_id]);
      await recordSecurityEvent(client, {
        userId: session.id,
        eventType: "credential_replay_detected",
        metadata: { credentialGeneration: session.generation },
        notifyOwner: true,
      });
      await client.query("COMMIT");
      transactionOpen = false;
      throw new HttpError(401, "A reused refresh credential revoked this session; sign in again", "SESSION_REUSE_DETECTED");
    }

    const nextRefreshToken = randomBytes(32).toString("base64url");
    const nextResponse: AuthResult = {
      user: toPublic(session),
      token: signToken({ sub: session.id, phone: session.phone_normalized, jti: session.session_id }),
      refreshToken: nextRefreshToken,
    };
    const retryCiphertext = encryptRefreshResponse(JSON.stringify(nextResponse));
    await client.query(
      `UPDATE session_refresh_tokens
          SET used_at=now(),retry_until=now()+interval '90 seconds',retry_ciphertext=$2
        WHERE token_hash=$1`,
      [presentedHash, retryCiphertext],
    );
    await client.query(
      "UPDATE sessions SET previous_refresh_token_hash=refresh_token_hash,refresh_token_hash=$2 WHERE id=$1",
      [session.session_id, hashRefreshToken(nextRefreshToken)],
    );
    await client.query(
      "INSERT INTO session_refresh_tokens(token_hash,session_id,generation) VALUES($1,$2,$3)",
      [hashRefreshToken(nextRefreshToken), session.session_id, session.generation + 1],
    );
    await recordSecurityEvent(client, {
      userId: session.id,
      eventType: "session_renewed",
      metadata: { authMethod: "refresh" },
    });
    await client.query("COMMIT");
    transactionOpen = false;
    return nextResponse;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function registerWithOtp(input: {
  phone: string;
  country?: string;
  challengeId: string;
  code: string;
  displayName?: string;
  language?: string;
  signupChannel?: SignupChannel;
  termsAccepted?: boolean;
  termsVersion?: string;
}): Promise<AuthResult> {
  if (input.termsAccepted !== true) throw new HttpError(400, "Terms acceptance is required", "VALIDATION_ERROR");
  const parsedPhone = parsePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined));
  const phone = parsedPhone.normalized;
  if (input.displayName !== undefined && (typeof input.displayName !== "string" || input.displayName.trim().length > 100)) throw new HttpError(400, "displayName must be at most 100 characters", "VALIDATION_ERROR");
  if (input.language !== undefined && (typeof input.language !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.language))) throw new HttpError(400, "language is invalid", "VALIDATION_ERROR");
  if (input.termsVersion !== undefined && input.termsVersion !== CURRENT_TERMS_VERSION) throw new HttpError(400, "Terms version is no longer current", "TERMS_VERSION_MISMATCH");
  const language = input.language ?? "en";
  const allowedChannels = new Set<SignupChannel>(["mobile", "web", "portal", "ivr"]);
  if (input.signupChannel !== undefined && !allowedChannels.has(input.signupChannel)) throw new HttpError(400, "signupChannel is invalid", "VALIDATION_ERROR");
  const channel = input.signupChannel && allowedChannels.has(input.signupChannel) ? input.signupChannel : "portal";
  const proof: DurableOtpProof = { challengeId: input.challengeId, phone, purpose: "signup", code: input.code };
  return withDurableOtpOperation([proof], "register", null, async (client, provenance) => {
    await lockPhoneIdentities(client, [phone]);
    await rejectAmbiguousLegacyIdentity(client, parsedPhone);
    const email = emailFromPhone(phone, config.mailDomain);
    const retired = await client.query("SELECT 1 FROM phone_history WHERE phone_normalized = $1 OR address = $2", [phone, email]);
    if (retired.rowCount) throw new HttpError(409, "This phone number is unavailable", "PHONE_IN_USE");
    const verificationProvenance = provenance[0] === "twilio_verify" ? "twilio" : "local_mock";
    const inserted = await client.query(
      `INSERT INTO users (phone_normalized, phone_e164, phone_country, password_hash, display_name, language, signup_channel, has_mobile_app, phone_verified_at, phone_verification_provenance, terms_accepted_at, terms_version)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, CASE WHEN $8 = 'twilio' THEN now() ELSE NULL END, $8, now(), $9) RETURNING *`,
      [phone, parsedPhone.e164, (parsedPhone.country ?? input.country?.toUpperCase() ?? config.phoneDefaultCountry) || null,
        input.displayName?.trim().slice(0, 100) ?? null, language, channel, channel === "mobile",
        verificationProvenance, CURRENT_TERMS_VERSION],
    );
    const user = inserted.rows[0];
    await client.query("INSERT INTO addresses (user_id, email, is_primary, is_alias) VALUES ($1,$2,TRUE,FALSE)", [user.id, email]);
    const session = await issueSession(client, user);
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "account_created",
      metadata: { authMethod: "otp", channel },
      notifyOwner: true,
    });
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "phone_proof_accepted",
      metadata: { verificationMethod: verificationProvenance },
      notifyOwner: true,
    });
    return { user: toPublic(user), ...session };
  }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505") throw new HttpError(409, "An account already exists for this phone number", "CONFLICT");
    throw error;
  });
}

export async function changePhoneNumber(input: {
  userId: string;
  sessionId: string;
  currentPassword?: string;
  newPhone: string;
  country?: string;
  challengeId: string;
  code: string;
  oldChallengeId?: string;
  oldCode?: string;
  idempotencyKey?: string;
  originalToken?: string;
}): Promise<AuthResult> {
  const parsedPhone = parsePhone(input.newPhone, input.country ?? (config.phoneDefaultCountry || undefined));
  const phone = parsedPhone.normalized;
  const accountResult = await query<UserRow>("SELECT * FROM users WHERE id = $1", [input.userId]);
  const before = accountResult.rows[0];
  if (!before) throw new HttpError(401, "Authentication required", "UNAUTHORIZED");
  if (phone === before.phone_normalized) throw new HttpError(400, "New phone number must differ from the current number", "PHONE_UNCHANGED");

  const proofs: DurableOtpProof[] = [];
  if (before.password_hash) {
    if (typeof input.currentPassword !== "string" || !input.currentPassword) throw new HttpError(403, "Password reauthentication is required", "REAUTH_REQUIRED");
    const provider = requirePasswordAuth();
    if (!(await provider.verify({ id: before.id, phoneNormalized: before.phone_normalized, passwordHash: before.password_hash }, input.currentPassword))) {
      throw new HttpError(401, "Reauthentication failed", "UNAUTHORIZED");
    }
  } else {
    if (!input.oldChallengeId || !input.oldCode) throw new HttpError(403, "Fresh verification of the current number is required", "REAUTH_REQUIRED");
    proofs.push({ challengeId: input.oldChallengeId, phone: before.phone_normalized, purpose: "phone_change_old", code: input.oldCode });
  }
  proofs.push({ challengeId: input.challengeId, phone, purpose: "phone_change", code: input.code });

  return withDurableOtpOperation(proofs, "phone_change", input.userId, async (client, provenance) => {
    await lockPhoneIdentities(client, [before.phone_normalized, phone]);
    await rejectAmbiguousLegacyIdentity(client, parsedPhone);
    await lockChangeAccounts(client, [input.userId]);
    const account = await client.query("SELECT * FROM users WHERE id = $1 FOR UPDATE", [input.userId]);
    const current = account.rows[0];
    if (!current || current.phone_normalized !== before.phone_normalized) throw new HttpError(409, "Account phone changed; restart verification", "PHONE_CHANGE_CONFLICT");
    const activeSession = await client.query("SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2 AND expires_at > now() FOR UPDATE", [input.sessionId, input.userId]);
    if (!activeSession.rowCount) throw new HttpError(401, "Session is no longer active", "UNAUTHORIZED");

    const occupied = await client.query("SELECT 1 FROM users WHERE phone_normalized = $1 AND id <> $2 FOR UPDATE", [phone, input.userId]);
    const newAddress = emailFromPhone(phone, config.mailDomain);
    const retired = await client.query("SELECT 1 FROM phone_history WHERE phone_normalized = $1 OR address = $2", [phone, newAddress]);
    if (occupied.rowCount || retired.rowCount) throw new HttpError(409, "This phone number is unavailable", "PHONE_IN_USE");
    const oldAddress = emailFromPhone(current.phone_normalized, config.mailDomain);
    const addressTaken = await client.query("SELECT 1 FROM addresses WHERE email = $1 AND user_id <> $2", [newAddress, input.userId]);
    if (addressTaken.rowCount) throw new HttpError(409, "This phone number is unavailable", "PHONE_IN_USE");

    const newProof = provenance[provenance.length - 1];
    const verificationProvenance = newProof === "twilio_verify" ? "twilio" : "local_mock";
    await client.query(
      "UPDATE users SET phone_normalized = $2, phone_e164 = $3, phone_country = $4, phone_verified_at = CASE WHEN $5 = 'twilio' THEN now() ELSE NULL END, phone_verification_provenance = $5, updated_at = now() WHERE id = $1",
      [current.id, phone, parsedPhone.e164, (parsedPhone.country ?? input.country?.toUpperCase() ?? config.phoneDefaultCountry) || null, verificationProvenance],
    );
    await client.query("UPDATE addresses SET email = $2 WHERE user_id = $1 AND is_primary", [current.id, newAddress]);
    await client.query(
      "INSERT INTO phone_history (user_id, phone_normalized, address, phone_e164, phone_country) VALUES ($1,$2,$3,$4,$5)",
      [current.id, current.phone_normalized, oldAddress, current.phone_e164, current.phone_country],
    );
    const revokedE2eeKey = await client.query(
      "UPDATE e2ee_public_keys SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL RETURNING fingerprint",
      [current.id],
    );
    if (revokedE2eeKey.rowCount) {
      await recordSecurityEvent(client, {
        userId: current.id,
        eventType: "e2ee_key_revoked_phone_change",
        metadata: { setting: "e2ee_key", value: "phone_change" },
        notifyOwner: true,
      });
    }
    await client.query(
      `UPDATE conversations c
          SET direct_pair_key = (
            SELECT string_agg(COALESCE(primary_address.email, cm.email), '|' ORDER BY COALESCE(primary_address.email, cm.email))
              FROM conversation_members cm
              LEFT JOIN addresses primary_address ON primary_address.user_id = cm.user_id AND primary_address.is_primary
             WHERE cm.conversation_id = c.id
          )
        WHERE c.kind = 'direct'
          AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.user_id = $1)`,
      [current.id],
    );
    await recordSecurityEvent(client, {
      userId: current.id,
      eventType: "phone_changed",
      metadata: { verificationMethod: newProof },
      notifyOwner: true,
    });
    await recordChange(client, current.id, "account", current.id, "phone_changed", { oldAddress, newAddress });
    await client.query("DELETE FROM sessions WHERE user_id = $1", [current.id]);
    const changedUser = {
      ...current,
      phone_normalized: phone,
      phone_e164: parsedPhone.e164,
      phone_country: (parsedPhone.country ?? input.country?.toUpperCase() ?? config.phoneDefaultCountry) || null,
    };
    const session = await issueSession(client, changedUser);
    const response = { user: toPublic(changedUser), ...session };
    if (input.idempotencyKey && input.originalToken) {
      const request: PhoneChangeRequest = {
        currentPassword: input.currentPassword,
        newPhone: input.newPhone,
        country: input.country,
        challengeId: input.challengeId,
        code: input.code,
        oldChallengeId: input.oldChallengeId,
        oldCode: input.oldCode,
      };
      await savePhoneChangeRecovery(client, {
        userId: input.userId,
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey,
        originalToken: input.originalToken,
        request,
        response,
      });
    }
    return response;
  }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505") {
      throw new HttpError(409, "This phone number is unavailable", "PHONE_IN_USE");
    }
    throw error;
  });
}

export async function loginWithOtp(input: { phone: string; country?: string; challengeId: string; code: string }): Promise<AuthResult> {
  const phone = normalizePhone(input.phone, input.country ?? (config.phoneDefaultCountry || undefined));
  const proof: DurableOtpProof = { challengeId: input.challengeId, phone, purpose: "login", code: input.code };
  return withDurableOtpOperation([proof], "login", null, async (client) => {
    const result = await client.query("SELECT * FROM users WHERE phone_normalized = $1 AND account_status='active' FOR UPDATE", [phone]);
    const user = result.rows[0];
    if (!user || user.password_hash) throw new HttpError(401, "Invalid phone number or OTP", "UNAUTHORIZED");
    const session = await issueSession(client, user);
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "login_succeeded",
      metadata: { authMethod: "otp" },
      notifyOwner: true,
    });
    await recordSecurityEvent(client, {
      userId: user.id,
      eventType: "phone_proof_accepted",
      metadata: { verificationMethod: "otp" },
      notifyOwner: true,
    });
    return { user: toPublic(user), ...session };
  });
}
