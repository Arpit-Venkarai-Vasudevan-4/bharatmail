import { randomBytes, randomUUID } from "node:crypto";
import * as openpgp from "openpgp";
import type { PoolClient } from "pg";
import { pool, query } from "../db";
import { HttpError } from "../httpError";
import { config } from "../config";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { assertNotBlocked } from "./contactService";
import { UUID_PATTERN } from "./conversationService";
import { recordSecurityEvent } from "./securityEventService";
import { passwordProvider } from "../auth/passwordProvider";
import { recordFailedAuthentication } from "./securityEventService";
import type { AuthUserRecord } from "../auth/provider";

const MAX_CIPHERTEXT_BYTES = 14 * 1024 * 1024;
const MAX_KEY_BYTES = 32 * 1024;
const UUIDS = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type E2eeAction = "enroll" | "rotate" | "revoke";

function validation(message: string): never {
  throw new HttpError(400, message, "VALIDATION_ERROR");
}

async function parsePublicEncryptionKey(armored: string, userId: string) {
  if (Buffer.byteLength(armored, "utf8") > MAX_KEY_BYTES ||
      !armored.startsWith("-----BEGIN PGP PUBLIC KEY BLOCK-----")) {
    validation("publicKey must be an armored public key under 32 KiB");
  }
  try {
    const key = await openpgp.readKey({ armoredKey: armored });
    const immutableUserId = new RegExp(`(?:^|<)${userId}@keys\\.phonemail\\.com(?:>|$)`, "i");
    if (key.isPrivate() || !key.getUserIDs().some((identity) => immutableUserId.test(identity))) {
      validation("publicKey must be a public key bound to this immutable PhoneMail user ID");
    }
    const encryptionKey = await key.getEncryptionKey();
    return {
      key,
      fingerprint: key.getFingerprint().toUpperCase(),
      encryptionKeyId: encryptionKey.getKeyID().toHex().toUpperCase(),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "publicKey is malformed, expired, or not encryption-capable", "KEY_INVALID");
  }
}

async function verifyProof(publicKey: openpgp.PublicKey, proof: string, message: string): Promise<void> {
  if (proof.length > 32 * 1024 || !proof.startsWith("-----BEGIN PGP SIGNATURE-----")) {
    throw new HttpError(401, "A valid OpenPGP proof-of-possession signature is required", "KEY_PROOF_INVALID");
  }
  try {
    const signedMessage = await openpgp.createMessage({ text: message });
    const signature = await openpgp.readSignature({ armoredSignature: proof });
    const result = await openpgp.verify({
      message: signedMessage,
      signature,
      verificationKeys: publicKey,
      expectSigned: true,
    });
    const checks = await Promise.all(result.signatures.map((item) => item.verified));
    if (checks.length !== 1 || checks.some((valid) => !valid)) throw new Error("signature mismatch");
  } catch {
    throw new HttpError(401, "OpenPGP proof-of-possession verification failed", "KEY_PROOF_INVALID");
  }
}

export async function reauthenticateE2ee(userId: string, sessionId: string, password: string) {
  if (!password || Buffer.byteLength(password, "utf8") > 1024) validation("password is required");
  const user = await query<{ id: string; phone_normalized: string; password_hash: string | null }>(
    "SELECT id,phone_normalized,password_hash FROM users WHERE id=$1 AND account_status='active'",
    [userId],
  );
  const account = user.rows[0];
  if (!account?.password_hash) {
    throw new HttpError(403, "E2EE key operations require password reauthentication; this account has no password credential", "REAUTH_REQUIRED");
  }
  const valid = await passwordProvider.verify({
    id: account.id,
    phoneNormalized: account.phone_normalized,
    passwordHash: account.password_hash,
  } satisfies AuthUserRecord, password);
  if (!valid) {
    await recordFailedAuthentication(userId, "e2ee_reauthentication");
    throw new HttpError(401, "Reauthentication failed", "UNAUTHORIZED");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE sessions SET reauthenticated_at=now()
        WHERE id=$1 AND user_id=$2 AND expires_at>now() RETURNING id`,
      [sessionId, userId],
    );
    if (!updated.rowCount) throw new HttpError(401, "Session is no longer active", "UNAUTHORIZED");
    await recordSecurityEvent(client, {
      userId,
      eventType: "e2ee_reauthenticated",
      metadata: { setting: "e2ee_key_operations" },
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function createKeyChallenge(userId: string, sessionId: string, action: E2eeAction) {
  if (!["enroll", "rotate", "revoke"].includes(action)) validation("action must be enroll, rotate, or revoke");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recentAuth = await client.query(
      `SELECT 1 FROM sessions WHERE id=$1 AND user_id=$2 AND expires_at>now()
        AND reauthenticated_at>now()-interval '5 minutes' FOR UPDATE`,
      [sessionId, userId],
    );
    if (!recentAuth.rowCount) {
      throw new HttpError(403, "Password reauthentication within the last five minutes is required", "REAUTH_REQUIRED");
    }
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const recent = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM e2ee_key_challenges
        WHERE user_id=$1 AND created_at > now()-interval '15 minutes'`,
      [userId],
    );
    if (Number(recent.rows[0]?.count ?? 0) >= 5) {
      throw new HttpError(429, "Key operations are rate limited; retry later", "RATE_LIMITED", true);
    }
    await client.query("DELETE FROM e2ee_key_challenges WHERE expires_at < now()-interval '1 day'");
    const active = await client.query("SELECT 1 FROM e2ee_public_keys WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
    if (action === "enroll" && active.rowCount) validation("an active key already exists; use rotate");
    if (action !== "enroll" && !active.rowCount) validation("no active key exists for this operation");
    const challenge = randomBytes(32).toString("base64url");
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO e2ee_key_challenges(user_id,session_id,action,challenge,expires_at)
       VALUES($1,$2,$3,$4,now()+interval '5 minutes') RETURNING id,expires_at`,
      [userId, sessionId, action, challenge],
    );
    await client.query("COMMIT");
    return {
      id: inserted.rows[0].id,
      action,
      challenge: `PhoneMail E2EE ${action} v1\nuserId:${userId}\nchallengeId:${inserted.rows[0].id}\nchallenge:${challenge}`,
      expiresAt: inserted.rows[0].expires_at,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function commitKeyOperation(input: {
  userId: string;
  sessionId: string;
  action: E2eeAction;
  challengeId: string;
  publicKey?: string;
  proof: string;
  previousProof?: string;
}) {
  if (!UUID_PATTERN.test(input.challengeId)) validation("challengeId must be a UUID");
  const client = await pool.connect();
  let fingerprint: string | null = null;
  try {
    await client.query("BEGIN");
    const challenge = await client.query<{ action: E2eeAction; challenge: string; expires_at: Date; consumed_at: Date | null }>(
      `SELECT action,challenge,expires_at,consumed_at FROM e2ee_key_challenges
        WHERE id=$1 AND user_id=$2 AND session_id=$3 FOR UPDATE`,
      [input.challengeId, input.userId, input.sessionId],
    );
    const row = challenge.rows[0];
    if (!row || row.consumed_at || row.expires_at.getTime() <= Date.now()) {
      throw new HttpError(409, "Key challenge is missing, expired, or already used", "KEY_CHALLENGE_INVALID");
    }
    if (row.action !== input.action) throw new HttpError(409, "Key challenge action does not match", "KEY_CHALLENGE_INVALID");
    const expectedProof = `PhoneMail E2EE ${input.action} v1\nuserId:${input.userId}\nchallengeId:${input.challengeId}\nchallenge:${row.challenge}`;
    await client.query("SELECT id FROM users WHERE id=$1 AND account_status='active' FOR UPDATE", [input.userId]);
    const current = await client.query<{ id: string; public_key: string; fingerprint: string }>(
      "SELECT id,public_key,fingerprint FROM e2ee_public_keys WHERE user_id=$1 AND revoked_at IS NULL FOR UPDATE",
      [input.userId],
    );
    if (input.action === "enroll" && current.rows[0]) validation("an active key already exists; use rotate");
    if (input.action !== "enroll" && !current.rows[0]) validation("no active key exists for this operation");

    if (input.action === "revoke") {
      if (input.publicKey !== undefined || input.previousProof !== undefined) validation("revoke accepts only the active-key proof");
      const oldKey = await parsePublicEncryptionKey(current.rows[0].public_key, input.userId);
      await verifyProof(oldKey.key, input.proof, expectedProof);
      await client.query("UPDATE e2ee_public_keys SET revoked_at=now() WHERE id=$1", [current.rows[0].id]);
    } else {
      if (typeof input.publicKey !== "string") validation("publicKey is required");
      const newKey = await parsePublicEncryptionKey(input.publicKey, input.userId);
      fingerprint = newKey.fingerprint;
      await verifyProof(newKey.key, input.proof, expectedProof);
      if (current.rows[0]?.fingerprint === newKey.fingerprint) {
        throw new HttpError(409, "A rotated key must have a new fingerprint", "KEY_ALREADY_REGISTERED");
      }
      const previouslyUsed = await client.query(
        "SELECT 1 FROM e2ee_public_keys WHERE fingerprint=$1",
        [newKey.fingerprint],
      );
      if (previouslyUsed.rowCount) {
        throw new HttpError(409, "This public-key fingerprint has already been registered", "KEY_ALREADY_REGISTERED");
      }
      if (input.action === "rotate") {
        if (typeof input.previousProof !== "string") validation("previousProof is required to rotate a key");
        const oldKey = await parsePublicEncryptionKey(current.rows[0].public_key, input.userId);
        await verifyProof(oldKey.key, input.previousProof, expectedProof);
        await client.query("UPDATE e2ee_public_keys SET revoked_at=now() WHERE id=$1", [current.rows[0].id]);
      } else if (input.previousProof !== undefined) {
        validation("previousProof is only accepted when rotating a key");
      }
      await client.query(
        `INSERT INTO e2ee_public_keys(user_id,fingerprint,encryption_key_id,public_key)
         VALUES($1,$2,$3,$4)`,
        [input.userId, newKey.fingerprint, newKey.encryptionKeyId, input.publicKey],
      );
    }
    await client.query("UPDATE e2ee_key_challenges SET consumed_at=now() WHERE id=$1", [input.challengeId]);
    await recordChange(client, input.userId, "account", input.userId, "upserted", { e2eeKeyChanged: true });
    await recordSecurityEvent(client, {
      userId: input.userId,
      eventType: "e2ee_key_changed",
      metadata: { setting: `e2ee_key_${input.action}`, value: input.action === "revoke" ? "revoked" : "updated" },
      notifyOwner: true,
    });
    await client.query("COMMIT");
    return { action: input.action, fingerprint };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listCurrentKeys(userIds: string[]) {
  if (userIds.length < 1 || userIds.length > 50 || userIds.some((id) => !UUIDS.test(id))) {
    validation("userIds must contain 1 to 50 user UUIDs");
  }
  const result = await query<{ user_id: string; fingerprint: string; encryption_key_id: string; public_key: string; created_at: Date }>(
    `SELECT user_id,fingerprint,encryption_key_id,public_key,created_at
       FROM e2ee_public_keys WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL`,
    [userIds],
  );
  return result.rows.sort((left, right) => left.user_id.localeCompare(right.user_id)).map((key) => ({
    userId: key.user_id,
    fingerprint: key.fingerprint,
    encryptionKeyId: key.encryption_key_id,
    publicKey: key.public_key,
    createdAt: key.created_at,
  }));
}

export async function listPublicKeyHistory(userId: string) {
  if (!UUIDS.test(userId)) validation("userId must be a UUID");
  const result = await query(
    `SELECT user_id AS "userId",fingerprint,encryption_key_id AS "encryptionKeyId",
            public_key AS "publicKey",created_at AS "createdAt",revoked_at AS "revokedAt"
       FROM e2ee_public_keys WHERE user_id=$1 ORDER BY created_at DESC,id DESC`,
    [userId],
  );
  return result.rows;
}

async function readEncryptionRecipients(client: PoolClient, userIds: string[], senderId: string) {
  const ids = [...new Set([senderId, ...userIds])];
  if (ids.length > 50 || ids.some((id) => !UUIDS.test(id))) validation("recipients must contain valid user IDs");
  const result = await client.query<{ user_id: string; email: string; fingerprint: string; encryption_key_id: string; public_key: string }>(
    `SELECT u.id AS user_id,a.email,k.fingerprint,k.encryption_key_id,k.public_key
       FROM users u
       JOIN addresses a ON a.user_id=u.id AND a.is_primary AND a.is_active
       JOIN e2ee_public_keys k ON k.user_id=u.id AND k.revoked_at IS NULL
      WHERE u.id=ANY($1::uuid[]) AND u.account_status='active'`,
    [ids],
  );
  const recipients = new Map(result.rows.map((row) => [row.user_id, row]));
  if (recipients.size !== ids.length) {
    throw new HttpError(409, "Every sender and recipient must have an active PhoneMail encryption key", "E2EE_KEY_REQUIRED");
  }
  return ids.map((id) => recipients.get(id)!);
}

async function verifyCiphertext(ciphertext: string, recipients: { encryption_key_id: string }[], fingerprints: string[]) {
  if (Buffer.byteLength(ciphertext, "utf8") > MAX_CIPHERTEXT_BYTES ||
      !ciphertext.startsWith("-----BEGIN PGP MESSAGE-----")) {
    throw new HttpError(400, "ciphertext must be an armored OpenPGP message under 14 MiB", "VALIDATION_ERROR");
  }
  const expectedFingerprints = [...fingerprints].map((value) => value.toUpperCase()).sort();
  const message = await openpgp.readMessage({ armoredMessage: ciphertext });
  const keyIds = message.getEncryptionKeyIDs().map((keyId) => keyId.toHex().toUpperCase()).sort();
  const expectedIds = recipients.map((recipient) => recipient.encryption_key_id.toUpperCase()).sort();
  if (JSON.stringify(keyIds) !== JSON.stringify(expectedIds) ||
      expectedFingerprints.length !== recipients.length ||
      new Set(expectedFingerprints).size !== expectedFingerprints.length) {
    throw new HttpError(400, "ciphertext recipient keys do not match the current key registry", "E2EE_RECIPIENT_MISMATCH");
  }
}

async function ensureCiphertextKeys(
  client: PoolClient,
  ids: string[],
  senderId: string,
  ciphertext: string,
  fingerprints: string[],
) {
  const recipients = await readEncryptionRecipients(client, ids, senderId);
  const activeFingerprints = recipients.map((item) => item.fingerprint.toUpperCase()).sort();
  if (JSON.stringify([...fingerprints].map((value) => value.toUpperCase()).sort()) !== JSON.stringify(activeFingerprints)) {
    throw new HttpError(409, "Public keys changed; verify fingerprints and encrypt again", "E2EE_KEY_CHANGED");
  }
  await verifyCiphertext(ciphertext, recipients, fingerprints);
  return recipients;
}

async function createEncryptedMessage(input: {
  userId: string;
  to: string[];
  cc: string[];
  ciphertext: string;
  keyFingerprints: string[];
  idempotencyKey: string;
  requestHash: string;
  replyToId?: string;
  sourceDraft?: { id: string; revision: number };
}) {
  if (!input.to.length || input.to.length + input.cc.length > 50 ||
      [...input.to, ...input.cc].some((id) => !UUIDS.test(id)) ||
      input.to.includes(input.userId) || input.cc.includes(input.userId) ||
      new Set(input.to).size !== input.to.length || new Set(input.cc).size !== input.cc.length ||
      input.cc.some((id) => input.to.includes(id))) validation("to and cc must identify distinct other PhoneMail users");
  if (!/^[\x20-\x7e]{8,128}$/.test(input.idempotencyKey)) validation("a valid Idempotency-Key is required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.e2ee-idempotency:${input.userId}:${input.idempotencyKey}`]);
    const prior = await client.query<{ resource_id: string; request_hash: string; expires_at: Date }>(
      `SELECT resource_id,request_hash,expires_at FROM idempotency_keys
        WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [input.userId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].expires_at.getTime() <= Date.now() || prior.rows[0].request_hash !== input.requestHash) {
        throw new HttpError(409, "Idempotency key is expired or was reused with different encrypted content", "IDEMPOTENCY_CONFLICT");
      }
      const found = await client.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM messages WHERE id=$1 AND sender_user_id=$2 AND content_format='openpgp-v1'",
        [prior.rows[0].resource_id, input.userId],
      );
      if (!found.rows[0]) throw new HttpError(409, "Encrypted message idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return { messageId: prior.rows[0].resource_id, conversationId: found.rows[0].conversation_id, duplicate: true };
    }
    if (input.sourceDraft) {
      const draft = await client.query<{ revision: number; sent_message_id: string | null }>(
        "SELECT revision,sent_message_id FROM e2ee_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE",
        [input.sourceDraft.id, input.userId],
      );
      if (!draft.rows[0] || draft.rows[0].sent_message_id || draft.rows[0].revision !== input.sourceDraft.revision) {
        throw new HttpError(409, "Encrypted draft revision conflict or draft already sent", "REVISION_CONFLICT");
      }
    }
    const allRecipientIds = [...new Set([...input.to, ...input.cc])];
    await client.query("SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE", [[input.userId, ...allRecipientIds]]);
    const recipients = await ensureCiphertextKeys(client, allRecipientIds, input.userId, input.ciphertext, input.keyFingerprints);
    const sender = recipients.find((recipient) => recipient.user_id === input.userId)!;
    await lockChangeAccounts(client, [input.userId, ...allRecipientIds]);
    await assertNotBlocked(input.userId, allRecipientIds, client);

    let conversationId: string;
    let parentId: string | null = null;
    if (input.replyToId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.e2ee-reply:${input.replyToId}`]);
      const parent = await client.query<{ conversation_id: string }>(
        `SELECT m.conversation_id FROM messages m
          JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1
         WHERE m.id=$2 AND m.content_format='openpgp-v1' AND m.folder <> 'drafts' FOR UPDATE OF m`,
        [input.userId, input.replyToId],
      );
      if (!parent.rows[0]) throw new HttpError(404, "Encrypted message to reply to was not found", "NOT_FOUND");
      const existingReply = await client.query("SELECT 1 FROM messages WHERE in_reply_to_id=$1", [input.replyToId]);
      if (existingReply.rowCount) throw new HttpError(409, "Encrypted message has already been replied to", "ALREADY_REPLIED");
      conversationId = parent.rows[0].conversation_id;
      parentId = input.replyToId;
      const members = await client.query<{ user_id: string }>(
        "SELECT user_id FROM conversation_members WHERE conversation_id=$1 AND user_id IS NOT NULL",
        [conversationId],
      );
      const expected = members.rows.map((member) => member.user_id).filter((id) => id !== input.userId).sort();
      if (JSON.stringify(expected) !== JSON.stringify(allRecipientIds.slice().sort())) {
        throw new HttpError(409, "Encrypted reply recipients must include the current conversation members", "E2EE_RECIPIENT_MISMATCH");
      }
    } else if (recipients.length === 2) {
      const pair = [sender.email, ...recipients.filter((item) => item.user_id !== input.userId).map((item) => item.email)]
        .sort().join("|").toLowerCase();
      const created = await client.query<{ id: string }>(
        `INSERT INTO conversations(kind,direct_pair_key) VALUES('direct',$1)
         ON CONFLICT(direct_pair_key) DO UPDATE SET direct_pair_key=EXCLUDED.direct_pair_key
         RETURNING id`,
        [pair],
      );
      conversationId = created.rows[0].id;
    } else {
      const created = await client.query<{ id: string }>(
        "INSERT INTO conversations(kind,direct_pair_key) VALUES('group',NULL) RETURNING id",
      );
      conversationId = created.rows[0].id;
    }

    const messageId = randomUUID();
    await client.query(
      `INSERT INTO idempotency_keys(user_id,idempotency_key,request_hash,resource_type,resource_id,expires_at)
       VALUES($1,$2,$3,'e2ee_message',$4,now()+interval '24 hours')`,
      [input.userId, input.idempotencyKey, input.requestHash, messageId],
    );
    await client.query(
      `INSERT INTO messages(id,conversation_id,sender_email,sender_user_id,subject,body,in_reply_to_id,folder,lifecycle_status,content_format,rfc_message_id)
       VALUES($1,$2,$3,$4,'Encrypted message','',$5,'inbox','committed','openpgp-v1',$6)`,
      [messageId, conversationId, sender.email, input.userId, parentId, `<${messageId}@${config.mailDomain}>`],
    );
    await client.query(
      "INSERT INTO e2ee_messages(message_id,ciphertext,key_fingerprints) VALUES($1,$2,$3::jsonb)",
      [messageId, input.ciphertext, JSON.stringify(input.keyFingerprints.map((item) => item.toUpperCase()).sort())],
    );
    const roleById = new Map<string, "to" | "cc">();
    for (const id of input.to) roleById.set(id, "to");
    for (const id of input.cc) if (!roleById.has(id)) roleById.set(id, "cc");
    for (const recipient of recipients) {
      await client.query(
        `INSERT INTO conversation_members(conversation_id,email,user_id)
         VALUES($1,$2,$3) ON CONFLICT(conversation_id,email) DO NOTHING`,
        [conversationId, recipient.email, recipient.user_id],
      );
      if (recipient.user_id !== input.userId) {
        await client.query(
          "INSERT INTO message_recipients(message_id,email,role,recipient_user_id) VALUES($1,$2,$3,$4)",
          [messageId, recipient.email, roleById.get(recipient.user_id) ?? "to", recipient.user_id],
        );
        await client.query(
          "INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder) VALUES($1,$2,FALSE,FALSE,'inbox')",
          [recipient.user_id, messageId],
        );
      }
    }
    await client.query(
      "INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder) VALUES($1,$2,TRUE,FALSE,'sent')",
      [input.userId, messageId],
    );
    const syncPayload = { id: messageId, conversationId, contentFormat: "openpgp-v1", createdAt: new Date().toISOString() };
    for (const userId of [input.userId, ...allRecipientIds]) {
      await recordChange(client, userId, "message", messageId, "upserted", syncPayload);
    }
    if (input.sourceDraft) {
      const updatedDraft = await client.query(
        `UPDATE e2ee_drafts SET sent_message_id=$2,updated_at=now()
          WHERE id=$1 AND user_id=$3 AND revision=$4 AND sent_message_id IS NULL
          RETURNING id,revision,updated_at`,
        [input.sourceDraft.id, messageId, input.userId, input.sourceDraft.revision],
      );
      if (!updatedDraft.rows[0]) throw new HttpError(409, "Encrypted draft changed while sending", "REVISION_CONFLICT");
      await recordChange(client, input.userId, "draft", input.sourceDraft.id, "upserted", {
        id: input.sourceDraft.id, revision: updatedDraft.rows[0].revision, contentFormat: "openpgp-v1", sent: true,
        updatedAt: updatedDraft.rows[0].updated_at,
      });
    }
    await client.query("COMMIT");
    return { messageId, conversationId, duplicate: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function sendEncryptedMessage(input: Parameters<typeof createEncryptedMessage>[0]) {
  return createEncryptedMessage(input);
}

export async function getEncryptedMessage(userId: string, messageId: string) {
  if (!UUID_PATTERN.test(messageId)) validation("messageId must be a UUID");
  const result = await query(
    `SELECT m.id,m.conversation_id AS "conversationId",m.sender_user_id AS "senderUserId",
            m.created_at AS "createdAt",m.in_reply_to_id AS "replyToId",e.ciphertext,e.key_fingerprints AS "keyFingerprints",
            m.content_format AS "contentFormat",
            ARRAY(SELECT jsonb_build_object('userId',mr.recipient_user_id,'email',mr.email,'role',mr.role)
                    FROM message_recipients mr WHERE mr.message_id=m.id ORDER BY mr.role,mr.email) AS recipients
       FROM messages m JOIN e2ee_messages e ON e.message_id=m.id
       JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1
      WHERE m.id=$2 AND m.content_format='openpgp-v1'`,
    [userId, messageId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Encrypted message not found", "NOT_FOUND");
  return result.rows[0];
}

export async function saveEncryptedDraft(input: { userId: string; id?: string; ciphertext: string; revision?: number }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id=$1 FOR SHARE", [input.userId]);
    await lockChangeAccounts(client, [input.userId]);
    const keys = await readEncryptionRecipients(client, [], input.userId);
    await verifyCiphertext(input.ciphertext, keys, keys.map((key) => key.fingerprint));
    let result;
    if (!input.id) {
      result = await client.query(
        "INSERT INTO e2ee_drafts(user_id,ciphertext) VALUES($1,$2) RETURNING id,ciphertext,revision,created_at,updated_at",
        [input.userId, input.ciphertext],
      );
    } else {
      if (!UUID_PATTERN.test(input.id)) validation("draft id must be a UUID");
      result = await client.query(
        `UPDATE e2ee_drafts SET ciphertext=$3,revision=revision+1,updated_at=now()
          WHERE id=$1 AND user_id=$2 AND sent_message_id IS NULL AND ($4::int IS NULL OR revision=$4)
          RETURNING id,ciphertext,revision,created_at,updated_at`,
        [input.id, input.userId, input.ciphertext, input.revision ?? null],
      );
      if (!result.rows[0]) throw new HttpError(409, "Encrypted draft revision conflict or draft unavailable", "REVISION_CONFLICT");
    }
    const draft = result.rows[0];
    await recordChange(client, input.userId, "draft", draft.id, "upserted", {
      id: draft.id, revision: draft.revision, contentFormat: "openpgp-v1", updatedAt: draft.updated_at,
    });
    await client.query("COMMIT");
    return { ...draft, contentFormat: "openpgp-v1" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listEncryptedDrafts(userId: string) {
  const result = await query(
    `SELECT id,ciphertext,revision,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM e2ee_drafts WHERE user_id=$1 AND sent_message_id IS NULL ORDER BY updated_at DESC LIMIT 100`,
    [userId],
  );
  return result.rows.map((draft) => ({ ...draft, contentFormat: "openpgp-v1" }));
}

export async function getEncryptedDraft(userId: string, id: string) {
  if (!UUID_PATTERN.test(id)) validation("draft id must be a UUID");
  const result = await query(
    `SELECT id,ciphertext,revision,created_at AS "createdAt",updated_at AS "updatedAt"
       FROM e2ee_drafts WHERE id=$1 AND user_id=$2 AND sent_message_id IS NULL`,
    [id, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Encrypted draft not found", "NOT_FOUND");
  return { ...result.rows[0], contentFormat: "openpgp-v1" };
}

export async function sendEncryptedDraft(input: {
  userId: string;
  id: string;
  revision: number;
  ciphertext: string;
  to: string[];
  cc: string[];
  keyFingerprints: string[];
  idempotencyKey: string;
  requestHash: string;
}) {
  if (!UUID_PATTERN.test(input.id)) validation("draft id must be a UUID");
  const sent = await createEncryptedMessage({
    ...input,
    sourceDraft: { id: input.id, revision: input.revision },
  });
  return sent;
}

export async function deleteEncryptedDraft(userId: string, id: string) {
  if (!UUID_PATTERN.test(id)) validation("draft id must be a UUID");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const deleted = await client.query(
      "DELETE FROM e2ee_drafts WHERE id=$1 AND user_id=$2 AND sent_message_id IS NULL RETURNING id",
      [id, userId],
    );
    if (!deleted.rowCount) throw new HttpError(404, "Encrypted draft not found", "NOT_FOUND");
    await recordChange(client, userId, "draft", id, "deleted", { id, deleted: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
