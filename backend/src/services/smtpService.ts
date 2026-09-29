import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import type { PoolClient } from "pg";
import { config } from "../config";
import { pool, query } from "../db";
import { HttpError } from "../httpError";
import { UUID_PATTERN } from "./conversationService";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { assertNotBlocked } from "./contactService";
import { createConfiguredMailTransport, type MailSendResult, type MailTransport, type OutgoingMail } from "../transport";
import { normalizeEmailAddress } from "../email";

const MAX_INBOUND_PARTS = 10;
const MAX_INBOUND_RECIPIENTS = 20;
const MAX_OUTBOUND_ATTACHMENTS = 10;

type Recipient = { email: string; role: "to" | "cc"; userId: string | null };
type MailInput = {
  to: string[];
  cc?: string[];
  subject?: string;
  body: string;
  attachmentIds?: string[];
  idempotencyKey: string;
  requestHash: string;
};

async function resolveRecipients(client: PoolClient, to: string[], cc: string[]): Promise<Recipient[]> {
  const roles = new Map<string, "to" | "cc">();
  for (const address of to) roles.set(normalizeEmailAddress(address), "to");
  for (const address of cc) {
    const email = normalizeEmailAddress(address);
    if (!roles.has(email)) roles.set(email, "cc");
  }
  if (roles.size === 0 || roles.size > 50) {
    throw new HttpError(400, "At least one recipient and at most 50 unique recipients are required", "VALIDATION_ERROR");
  }
  const emails = [...roles.keys()];
  const result = await client.query<{ email: string; user_id: string; account_status: string; is_active: boolean }>(
    `SELECT a.email,a.user_id,u.account_status,a.is_active
       FROM addresses a JOIN users u ON u.id=a.user_id
      WHERE lower(a.email)=ANY($1::text[])`,
    [emails],
  );
  const found = new Map(result.rows.map((row) => [row.email.toLowerCase(), row]));
  const resolved: Recipient[] = [];
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (domain === config.mailDomain) {
      const local = found.get(email);
      if (!local || !local.is_active || local.account_status !== "active") {
        throw new HttpError(409, "PhoneMail recipient address is unknown, retired, or inactive", "RECIPIENT_UNAVAILABLE");
      }
      resolved.push({ email: local.email, role: roles.get(email)!, userId: local.user_id });
    } else {
      resolved.push({ email, role: roles.get(email)!, userId: null });
    }
  }
  return resolved;
}

function dedupeKey(messageId: string | undefined, contentDigest: string, rawDigest: string, envelopeFrom: string | null, recipientId: string): string {
  return createHash("sha256")
    .update(recipientId).update("\0")
    .update(messageId ?? "no-message-id").update("\0")
    .update(envelopeFrom ?? "").update("\0")
    .update(messageId ? contentDigest : rawDigest)
    .digest("hex");
}

function safeHeaderAddress(parsed: ParsedMail["from"]): string | null {
  const address = parsed?.value.find((value) => value.address)?.address;
  if (!address) return null;
  try { return normalizeEmailAddress(address); } catch { return null; }
}

function safeFilename(value: string | undefined): string {
  const leaf = basename((value ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 180);
  return leaf && leaf !== "." && leaf !== ".." ? leaf : "attachment";
}

function plainText(parsed: ParsedMail): string {
  if (parsed.text?.trim()) return parsed.text.slice(0, 100_000);
  if (typeof parsed.html !== "string") return "";
  return parsed.html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .slice(0, 100_000);
}

async function idempotentMessage(client: PoolClient, userId: string, key: string, hash: string) {
  const existing = await client.query<{ request_hash: string; resource_id: string; expires_at: Date }>(
    `SELECT request_hash,resource_id,expires_at
       FROM idempotency_keys WHERE user_id=$1 AND idempotency_key=$2 FOR UPDATE`,
    [userId, key],
  );
  if (!existing.rows[0]) return null;
  if (existing.rows[0].expires_at.getTime() <= Date.now()) {
    throw new HttpError(409, "Idempotency key has expired; use a new key", "IDEMPOTENCY_EXPIRED");
  }
  if (existing.rows[0].request_hash !== hash) {
    throw new HttpError(409, "Idempotency key was reused with different content", "IDEMPOTENCY_CONFLICT");
  }
  return existing.rows[0].resource_id;
}

async function createOutgoingMessage(userId: string, input: MailInput, reply?: { conversationId: string; parentId: string }) {
  if (input.subject !== undefined && (input.subject.length > 200 || /[\r\n\0]/.test(input.subject))) {
    throw new HttpError(400, "Subject must be at most 200 characters and contain no header breaks", "VALIDATION_ERROR");
  }
  if (!input.body.trim() || input.body.length > 100_000) {
    throw new HttpError(400, "Message body is required and must be at most 100000 characters", "VALIDATION_ERROR");
  }
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  if (attachmentIds.length > MAX_OUTBOUND_ATTACHMENTS || attachmentIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new HttpError(400, "Attachment references are invalid or exceed the limit", "ATTACHMENT_INVALID");
  }
  if (!/^[\x20-\x7e]{8,128}$/.test(input.idempotencyKey)) {
    throw new HttpError(400, "Idempotency-Key must be 8 to 128 printable characters", "VALIDATION_ERROR");
  }

  const client = await pool.connect();
  let messageId = "";
  let conversationId = reply?.conversationId ?? "";
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.smtp-idempotency:${userId}:${input.idempotencyKey}`]);
    const prior = await idempotentMessage(client, userId, input.idempotencyKey, input.requestHash);
    if (prior) {
      const existing = await client.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM messages WHERE id=$1 AND sender_user_id=$2",
        [prior, userId],
      );
      if (!existing.rows[0]) throw new HttpError(409, "Idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return { messageId: prior, conversationId: existing.rows[0].conversation_id };
    }
    const sender = await client.query<{ email: string }>(
      `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
        WHERE a.user_id=$1 AND a.is_primary AND a.is_active AND u.account_status='active'`,
      [userId],
    );
    if (!sender.rows[0]) throw new HttpError(403, "No active primary PhoneMail address is available", "ADDRESS_UNAVAILABLE");
    const senderEmail = sender.rows[0].email;

    let parent: {
      id: string; subject: string; rfc_message_id: string | null; references_header: string[];
      header_from: string | null; envelope_from: string | null;
    } | undefined;
    let recipients: Recipient[];
    if (reply) {
      const parentResult = await client.query<NonNullable<typeof parent> & { header_from: string | null }>(
        `SELECT m.id,m.subject,m.rfc_message_id,m.references_header,m.header_from,m.envelope_from
           FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
           JOIN user_message_state ums ON ums.message_id=m.id AND ums.user_id=$1
          WHERE m.id=$2 AND m.conversation_id=$3 AND cm.user_id=$1
            AND m.sender_user_id IS NULL AND m.header_from IS NOT NULL AND m.envelope_from IS NOT NULL
            AND COALESCE(ums.folder,m.folder) <> 'drafts'
          FOR UPDATE OF m`,
        [userId, reply.parentId, reply.conversationId],
      );
      parent = parentResult.rows[0];
      if (!parent) throw new HttpError(404, "Incoming message not found", "NOT_FOUND");
      const email = parent.header_from ? normalizeEmailAddress(parent.header_from) : "";
      if (email.endsWith(`@${config.mailDomain}`)) {
        throw new HttpError(400, "Replies to local PhoneMail senders must use the conversation API", "RECIPIENT_UNAVAILABLE");
      }
      recipients = [{ email, role: "to", userId: null }];
      const existingReply = await client.query("SELECT 1 FROM messages WHERE in_reply_to_id=$1", [parent.id]);
      if (existingReply.rowCount) throw new HttpError(409, "This message has already been replied to", "ALREADY_REPLIED");
    } else {
      recipients = await resolveRecipients(client, input.to, input.cc ?? []);
      if (recipients.some((recipient) => recipient.userId === userId)) {
        throw new HttpError(400, "The sender cannot be a recipient", "VALIDATION_ERROR");
      }
      const localIds = [...new Set(recipients.flatMap((recipient) => recipient.userId ? [recipient.userId] : []))];
      await lockChangeAccounts(client, [userId, ...localIds]);
      await assertNotBlocked(userId, localIds, client);
    }

    const localRecipients = recipients.filter((recipient) => recipient.userId);
    const externalRecipients = recipients.filter((recipient) => !recipient.userId);
    if (!reply) {
      const participants = [senderEmail, ...recipients.map((recipient) => recipient.email)].sort();
      if (participants.length === 2) {
        const directPairKey = participants.join("|").toLowerCase();
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM conversations WHERE kind='direct' AND direct_pair_key=$1",
          [directPairKey],
        );
        if (existing.rows[0]) {
          conversationId = existing.rows[0].id;
          const memberCheck = await client.query<{ email: string }>(
            "SELECT email FROM conversation_members WHERE conversation_id=$1 ORDER BY email",
            [conversationId],
          );
          if (memberCheck.rows.map((row) => row.email.toLowerCase()).sort().join("|") !== participants.join("|")) {
            throw new HttpError(409, "Direct conversation identity changed; compose a new message", "RECIPIENTS_LOCKED");
          }
        } else {
          const created = await client.query<{ id: string }>(
            "INSERT INTO conversations(kind,direct_pair_key) VALUES('direct',$1) RETURNING id",
            [directPairKey],
          );
          conversationId = created.rows[0].id;
        }
      } else {
        const created = await client.query<{ id: string }>(
          "INSERT INTO conversations(kind,direct_pair_key) VALUES('group',NULL) RETURNING id",
        );
        conversationId = created.rows[0].id;
      }
      const memberEmails = new Map<string, string | null>([[senderEmail, userId]]);
      for (const recipient of recipients) {
        const existingUser = memberEmails.get(recipient.email);
        if (existingUser && existingUser !== recipient.userId) {
          throw new HttpError(409, "Recipient identity conflict", "RECIPIENT_UNAVAILABLE");
        }
        memberEmails.set(recipient.email, recipient.userId);
      }
      for (const [email, memberId] of memberEmails) {
        await client.query(
          "INSERT INTO conversation_members(conversation_id,email,user_id) VALUES($1,$2,$3) ON CONFLICT(conversation_id,email) DO NOTHING",
          [conversationId, email, memberId],
        );
      }
    }

    const uploadRows = attachmentIds.length
      ? await client.query<{ id: string; filename: string; mime_type: string; size_bytes: number; storage_key: string; scanner_state: string }>(
        `SELECT id,filename,mime_type,size_bytes,storage_key,scanner_state FROM uploads
          WHERE id=ANY($1::uuid[]) AND user_id=$2 AND status='ready' AND expires_at>now()`,
        [attachmentIds, userId],
      )
      : { rows: [] as { id: string; filename: string; mime_type: string; size_bytes: number; storage_key: string; scanner_state: string }[] };
    if (uploadRows.rows.length !== attachmentIds.length) {
      throw new HttpError(400, "Attachments must be owned, ready uploads", "ATTACHMENT_INVALID");
    }
    const encodedAttachmentBytes = uploadRows.rows.reduce((total, row) => total + Math.ceil(row.size_bytes * 4 / 3), 0);
    if (encodedAttachmentBytes + Buffer.byteLength(input.body, "utf8") > config.smtp.maxMessageBytes) {
      throw new HttpError(413, "Message exceeds the configured SMTP MIME size limit", "MESSAGE_TOO_LARGE");
    }

    messageId = randomUUID();
    const rfcMessageId = `<${messageId}@${config.mailDomain}>`;
    const keyInsert = await client.query(
      `INSERT INTO idempotency_keys(user_id,idempotency_key,request_hash,resource_type,resource_id,expires_at)
       VALUES($1,$2,$3,'message',$4,now()+interval '24 hours') ON CONFLICT(user_id,idempotency_key) DO NOTHING`,
      [userId, input.idempotencyKey, input.requestHash, messageId],
    );
    if (!keyInsert.rowCount) {
      const duplicate = await idempotentMessage(client, userId, input.idempotencyKey, input.requestHash);
      if (!duplicate) throw new HttpError(409, "Idempotency conflict", "IDEMPOTENCY_CONFLICT");
      const found = await client.query<{ conversation_id: string }>("SELECT conversation_id FROM messages WHERE id=$1", [duplicate]);
      if (!found.rows[0]) throw new HttpError(409, "Idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return { messageId: duplicate, conversationId: found.rows[0].conversation_id };
    }
    const parentSubject = parent?.subject ?? "";
    const message = await client.query<{ created_at: Date }>(
      `INSERT INTO messages(id,conversation_id,sender_email,sender_user_id,subject,body,in_reply_to_id,folder,lifecycle_status,rfc_message_id,references_header)
       VALUES($1,$2,$3,$4,$5,$6,$7,'inbox','committed',$8,$9) RETURNING created_at`,
      [
        messageId, conversationId, senderEmail, userId,
        reply ? (input.subject?.trim() ? input.subject : (/^re:/i.test(parentSubject) ? parentSubject : `Re: ${parentSubject}`)) : (input.subject ?? ""),
        input.body, parent?.id ?? null, rfcMessageId,
        parent ? [...new Set([...(parent.references_header ?? []), ...(parent.rfc_message_id ? [parent.rfc_message_id] : [])])] : [],
      ],
    );
    for (const recipient of recipients) {
      await client.query(
        "INSERT INTO message_recipients(message_id,email,role,recipient_user_id) VALUES($1,$2,$3,$4)",
        [messageId, recipient.email, recipient.role, recipient.userId],
      );
    }
    for (const row of uploadRows.rows) {
      await client.query(
        "INSERT INTO attachments(message_id,filename,mime_type,size_bytes,storage_key,scanner_state) VALUES($1,$2,$3,$4,$5,$6)",
        [messageId, row.filename, row.mime_type, row.size_bytes, row.storage_key, row.scanner_state],
      );
    }
    await client.query(
      "INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder) VALUES($1,$2,TRUE,FALSE,'sent')",
      [userId, messageId],
    );
    for (const recipient of localRecipients) {
      const localId = recipient.userId!;
      await client.query(
        `INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder)
         VALUES($1,$2,FALSE,FALSE,'inbox') ON CONFLICT(user_id,message_id) DO NOTHING`,
        [localId, messageId],
      );
      await client.query(
        "INSERT INTO message_deliveries(message_id,recipient_user_id,status) VALUES($1,$2,'local_committed') ON CONFLICT DO NOTHING",
        [messageId, localId],
      );
      await recordChange(client, localId, "message", messageId, "created", { conversationId });
    }
    await recordChange(client, userId, "message", messageId, "created", { conversationId });
    for (const recipient of externalRecipients) {
      await client.query(
        "INSERT INTO smtp_message_deliveries(message_id,recipient_email,role,status) VALUES($1,$2,$3,'queued')",
        [messageId, recipient.email, recipient.role],
      );
    }
    if (localRecipients.length) {
      await client.query(
        "INSERT INTO outbox_jobs(kind,payload) VALUES('message.notification',$1::jsonb)",
        [JSON.stringify({ messageId, conversationId, senderUserId: userId })],
      );
    }
    if (externalRecipients.length) {
      await client.query(
        "INSERT INTO outbox_jobs(kind,payload) VALUES('message.smtp-delivery',$1::jsonb)",
        [JSON.stringify({ messageId })],
      );
    }
    await client.query("UPDATE conversations SET updated_at=$2 WHERE id=$1", [conversationId, message.rows[0].created_at]);
    await client.query("COMMIT");
    return { messageId, conversationId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "23505") {
      throw new HttpError(409, "This message has already been replied to or the conversation already exists", "ALREADY_REPLIED");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function composeMail(userId: string, input: MailInput) {
  const result = await createOutgoingMessage(userId, input);
  return { ...result, delivery: input.to.some((address) => !address.toLowerCase().endsWith(`@${config.mailDomain}`)) ? "smtp_queued" : "local_committed" };
}

export async function replyToIncomingMail(userId: string, conversationId: string, messageId: string, input: Omit<MailInput, "to" | "cc">) {
  const result = await createOutgoingMessage(userId, { ...input, to: [], cc: [] }, { conversationId, parentId: messageId });
  return { ...result, delivery: "smtp_queued" };
}

export function classifySmtpDeliveryOutcome(
  deliveries: { recipient_email: string; status?: string; attempts?: number }[],
  result: Pick<MailSendResult, "accepted" | "rejected" | "rejectedDetails" | "response">,
  transportMode: string,
): { updates: Array<{ recipient_email: string; status: string; attempts: number; last_error: string | null }>; shouldRetry: boolean; ambiguous: boolean } {
  const responseCode = Number((result.response || "").match(/^\s*(\d{3})/)?.[1] ?? 0);
  const accepted = new Set((result.accepted ?? []).map((email: string) => email.toLowerCase()));
  const rejected = new Map<string, { code: number; message: string }>();
  for (const detail of result.rejectedDetails ?? []) {
    const key = detail.address.toLowerCase();
    if (key) rejected.set(key, { code: detail.code || 0, message: detail.message || "Relay rejected recipient" });
  }
  for (const entry of result.rejected ?? []) {
    const address = typeof entry === "string"
      ? entry
      : typeof (entry as { address?: string })?.address === "string"
        ? (entry as { address?: string }).address ?? ""
        : "";
    const key = address.trim().toLowerCase();
    if (!key || accepted.has(key)) continue;
    if (!rejected.has(key)) {
      const fallbackCode = Number.isFinite(responseCode) && responseCode > 0 ? (responseCode >= 500 ? 550 : 450) : 550;
      rejected.set(key, { code: fallbackCode, message: "Relay rejected recipient" });
    }
  }
  const updates: Array<{ recipient_email: string; status: string; attempts: number; last_error: string | null }> = [];
  let shouldRetry = false;
  let ambiguous = false;

  for (const delivery of deliveries) {
    const normalized = delivery.recipient_email.toLowerCase();
    if (accepted.has(normalized)) {
      updates.push({
        recipient_email: delivery.recipient_email,
        status: transportMode === "file" ? "simulated" : "relay_accepted",
        attempts: (delivery.attempts ?? 0) + 1,
        last_error: null,
      });
      continue;
    }

    const detail = rejected.get(normalized);
    if (detail) {
      const status = detail.code >= 500 ? "failed" : "retrying";
      updates.push({
        recipient_email: delivery.recipient_email,
        status,
        attempts: (delivery.attempts ?? 0) + 1,
        last_error: detail.message || `Relay rejected recipient (${detail.code || "unknown"})`,
      });
      shouldRetry ||= status === "retrying";
      continue;
    }

    const finalResponseIsUncertain = responseCode === 0 || (responseCode > 0 && responseCode < 500);
    const status = finalResponseIsUncertain ? "acceptance_unknown" : "failed";
    const lastError = result.response
      ? `SMTP relay response: ${result.response}`
      : "SMTP relay response did not identify a recipient outcome";
    updates.push({
      recipient_email: delivery.recipient_email,
      status,
      attempts: (delivery.attempts ?? 0) + 1,
      last_error: lastError,
    });
    shouldRetry ||= status === "acceptance_unknown";
    ambiguous ||= status === "acceptance_unknown" && (responseCode > 0 && responseCode < 500);
  }

  return { updates, shouldRetry, ambiguous };
}

export function isolateUncommittedAttachmentFiles(files: string[], committedPaths: Set<string>): string[] {
  return files.filter((file) => !committedPaths.has(file));
}

export async function processSmtpDelivery(messageId: string, transport: MailTransport): Promise<void> {
  const messageResult = await query<{
    conversation_id: string; sender_email: string; subject: string; body: string; created_at: Date;
    rfc_message_id: string; in_reply_to_id: string | null; references_header: string[];
  }>(
    `SELECT conversation_id,sender_email,subject,body,created_at,rfc_message_id,in_reply_to_id,references_header
       FROM messages WHERE id=$1 AND lifecycle_status='committed'`,
    [messageId],
  );
  const message = messageResult.rows[0];
  if (!message?.rfc_message_id) throw new Error("SMTP outbox references a message without a stable Message-ID");
  const deliveryRows = await query<{ recipient_email: string; role: "to" | "cc"; status: string; attempts: number }>(
    `SELECT recipient_email,role,status,attempts FROM smtp_message_deliveries
      WHERE message_id=$1 AND status IN ('queued','retrying','acceptance_unknown')
      ORDER BY recipient_email`,
    [messageId],
  );
  if (!deliveryRows.rows.length) return;
  const attachmentRows = await query<{ filename: string; mime_type: string; size_bytes: number; storage_key: string }>(
    "SELECT filename,mime_type,size_bytes,storage_key FROM attachments WHERE message_id=$1 ORDER BY id",
    [messageId],
  );
  const attachmentBytes = attachmentRows.rows.reduce((sum, row) => sum + Math.ceil(row.size_bytes * 4 / 3), 0);
  if (attachmentBytes + Buffer.byteLength(message.body, "utf8") > config.smtp.maxMessageBytes) {
    await query(
      "UPDATE smtp_message_deliveries SET status='failed',last_error='MIME size limit exceeded',updated_at=now() WHERE message_id=$1 AND status IN ('queued','retrying','acceptance_unknown')",
      [messageId],
    );
    return;
  }
  const attachments = attachmentRows.rows.map((row) => {
    if (!UUID_PATTERN.test(row.storage_key)) throw new Error("Attachment storage key is not server generated");
    return {
      filename: safeFilename(row.filename),
      contentType: row.mime_type,
      path: join(config.storageDir, row.storage_key),
    };
  });
  const envelope = deliveryRows.rows.map((row) => row.recipient_email);
  let classification: ReturnType<typeof classifySmtpDeliveryOutcome> | undefined;
  try {
    const result = await transport.send({
      from: message.sender_email,
      to: (await query<{ email: string }>("SELECT email FROM message_recipients WHERE message_id=$1 AND role='to' ORDER BY id", [messageId])).rows.map((row) => row.email),
      cc: (await query<{ email: string }>("SELECT email FROM message_recipients WHERE message_id=$1 AND role='cc' ORDER BY id", [messageId])).rows.map((row) => row.email),
      subject: message.subject,
      text: message.body,
      messageId: message.rfc_message_id,
      date: message.created_at,
      ...(message.in_reply_to_id ? {
        inReplyTo: (await query<{ rfc_message_id: string | null }>("SELECT rfc_message_id FROM messages WHERE id=$1", [message.in_reply_to_id])).rows[0]?.rfc_message_id ?? undefined,
      } : {}),
      references: message.references_header,
      attachments,
      envelope: { from: message.sender_email, to: envelope },
    });
    classification = classifySmtpDeliveryOutcome(deliveryRows.rows, result, config.mailTransportMode);
    for (const update of classification.updates) {
      await query(
        `UPDATE smtp_message_deliveries
            SET status=$3,attempts=$4,last_error=$5,updated_at=now()
          WHERE message_id=$1 AND recipient_email=$2`,
        [messageId, update.recipient_email, update.status, update.attempts, update.last_error],
      );
    }
    if (classification.shouldRetry || classification.ambiguous) {
      const error = new Error(classification.ambiguous ? "SMTP relay returned an ambiguous delivery result" : "SMTP relay temporarily rejected one or more recipients");
      Object.assign(error, { responseCode: 450 });
      throw error;
    }
  } catch (error) {
    if (classification) {
      throw error;
    }
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    const responseCode = typeof error === "object" && error && "responseCode" in error ? Number((error as { responseCode?: unknown }).responseCode ?? 0) : 0;
    const errorPath = error && typeof error === "object" && "path" in error ? (error as { path?: unknown }).path : undefined;
    const errorCommand = error && typeof error === "object" && "command" in error ? String((error as { command?: unknown }).command ?? "") : "";
    const localAttachmentStorageFailure = errorCommand === "API" &&
      ["EACCES", "EIO", "ENOENT", "ESTREAM"].includes(code) &&
      typeof errorPath === "string" &&
      UUID_PATTERN.test(basename(errorPath)) &&
      attachments.some((attachment) => resolve(errorPath) === resolve(attachment.path));
    const retryable = responseCode === 0 || responseCode < 500;
    const status = localAttachmentStorageFailure ? "retrying" : retryable ? "acceptance_unknown" : "failed";
    const nonAcceptedRows = deliveryRows.rows.filter((row) => row.status !== "relay_accepted" && row.status !== "simulated" && row.status !== "failed");
    if (nonAcceptedRows.length) {
      await Promise.all(nonAcceptedRows.map((row) => query(
        `UPDATE smtp_message_deliveries SET status=$3,attempts=attempts+1,last_error=$4,updated_at=now()
          WHERE message_id=$1 AND recipient_email=$2 AND status IN ('queued','retrying','acceptance_unknown')`,
        [messageId, row.recipient_email, status, `SMTP ${code || "delivery"} failure`],
      )));
    }
    if (retryable) throw error;
  }
}

async function acceptedRecipients(raw: Buffer, envelopeFrom: string | null, envelopeTo: string[]) {
  const parsed = await simpleParser(raw, { maxHtmlLengthToParse: 100_000 });
  if (parsed.attachments.length > MAX_INBOUND_PARTS) {
    throw Object.assign(new Error("Too many MIME parts"), { responseCode: 552 });
  }
  const sender = safeHeaderAddress(parsed.from);
  const recipients = await query<{ email: string; user_id: string; account_status: string }>(
    `SELECT a.email,a.user_id,u.account_status
       FROM addresses a JOIN users u ON u.id=a.user_id
      WHERE lower(a.email)=ANY($1::text[]) AND a.is_active
      ORDER BY array_position($1::text[], lower(a.email))`,
    [envelopeTo.map((email) => email.toLowerCase())],
  );
  if (recipients.rows.length === 0 || recipients.rows.some((row) => row.account_status !== "active")) {
    throw Object.assign(new Error("Recipient is no longer active"), { responseCode: 550 });
  }
  const uniqueUsers = new Map(recipients.rows.map((row) => [row.user_id, row]));
  const rawHash = createHash("sha256").update(raw).digest("hex");
  const files: string[] = [];
  const committedPaths = new Set<string>();
  const committedIds: string[] = [];
  const parsedTo = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((group) => group.value) : [];
  const parsedCc = parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((group) => group.value) : [];
  const headerRecipients = [
    ...parsedTo.flatMap((item) => item.address ? [{ email: normalizeEmailAddress(item.address), role: "to" as const }] : []),
    ...parsedCc.flatMap((item) => item.address ? [{ email: normalizeEmailAddress(item.address), role: "cc" as const }] : []),
  ];
  const text = plainText(parsed);
  const subject = (parsed.subject ?? "").replace(/[\r\n\0]/g, " ").slice(0, 200);
  const attachmentSize = parsed.attachments.reduce((size, attachment) => size + attachment.size, 0);
  const contentDigest = createHash("sha256").update(JSON.stringify({
    sender,
    subject,
    text,
    recipients: headerRecipients,
    attachments: parsed.attachments.map((attachment) => ({
      checksum: attachment.checksum,
      size: attachment.size,
      contentType: attachment.contentType,
    })),
  })).digest("hex");
  if (attachmentSize > config.smtp.maxMessageBytes || !text.trim() && !parsed.attachments.length) {
    throw Object.assign(new Error("MIME content is empty or exceeds limits"), { responseCode: 552 });
  }
  try {
    for (const recipient of uniqueUsers.values()) {
      const userId = recipient.user_id;
      const dedupe = dedupeKey(parsed.messageId, contentDigest, rawHash, envelopeFrom, userId);
      const client = await pool.connect();
      const localFiles: { storageKey: string; filename: string; mimeType: string; size: number }[] = [];
      try {
        await client.query("BEGIN");
        await lockChangeAccounts(client, [userId]);
        const current = await client.query<{ email: string }>(
          `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
            WHERE a.email=$1 AND a.user_id=$2 AND a.is_active AND u.account_status='active' FOR UPDATE`,
          [recipient.email, userId],
        );
        if (!current.rows[0]) throw Object.assign(new Error("Recipient became unavailable"), { responseCode: 550 });
        const duplicate = await client.query<{ message_id: string }>(
          `SELECT message_id FROM inbound_mail_dedup
            WHERE recipient_user_id=$1 AND deduplication_key=$2`,
          [userId, dedupe],
        );
        if (duplicate.rows[0]) {
          await client.query("COMMIT");
          committedIds.push(duplicate.rows[0].message_id);
          continue;
        }
        const senderEmail = current.rows[0].email;
        const conversationPair = [senderEmail, sender ?? "unknown@invalid"].sort().join("|").toLowerCase();
        const conversationResult = await client.query<{ id: string }>(
          `INSERT INTO conversations(kind,direct_pair_key) VALUES('direct',$1)
           ON CONFLICT(direct_pair_key) DO UPDATE SET updated_at=conversations.updated_at
           RETURNING id`,
          [conversationPair],
        );
        const conversationId = conversationResult.rows[0].id;
        if (sender) {
          await client.query(
            "INSERT INTO conversation_members(conversation_id,email,user_id) VALUES($1,$2,NULL) ON CONFLICT DO NOTHING",
            [conversationId, sender],
          );
        }
        await client.query(
          "INSERT INTO conversation_members(conversation_id,email,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [conversationId, senderEmail, userId],
        );
        const messageId = randomUUID();
        const safeMessageId = parsed.messageId && parsed.messageId.length <= 998 &&
          /^<[^<>@\s\r\n]+@[^<>@\s\r\n]+>$/.test(parsed.messageId) ? parsed.messageId : null;
        const references = (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])
          .filter((value) => value.length <= 998 && /^<[^<>@\s\r\n]+@[^<>@\s\r\n]+>$/.test(value)).slice(-20);
        const message = await client.query<{ created_at: Date }>(
          `INSERT INTO messages(id,conversation_id,sender_email,sender_user_id,subject,body,folder,lifecycle_status,
              rfc_message_id,references_header,envelope_from,header_from,received_at)
           VALUES($1,$2,$3,NULL,$4,$5,'inbox','committed',$6,$7,$8,$9,now()) RETURNING created_at`,
          [messageId, conversationId, sender ?? "unknown@invalid", subject, text, safeMessageId, references, envelopeFrom, sender],
        );
        const visible = new Map<string, "to" | "cc">();
        for (const item of headerRecipients) if (!visible.has(item.email)) visible.set(item.email, item.role);
        if (![...visible.keys()].includes(senderEmail)) visible.set(senderEmail, "to");
        for (const [email, role] of visible) {
          await client.query(
            `INSERT INTO message_recipients(message_id,email,role,recipient_user_id)
             VALUES($1,$2,$3,CASE WHEN lower($2)=lower($4) THEN $5::uuid ELSE NULL END)`,
            [messageId, email, role, senderEmail, userId],
          );
        }
        for (const attachment of parsed.attachments) {
          const storageKey = randomUUID();
          const filename = safeFilename(attachment.filename);
          const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) ? attachment.contentType : "application/octet-stream";
          const path = join(config.storageDir, storageKey);
          await writeFile(path, attachment.content, { flag: "wx", mode: 0o600 });
          files.push(path);
          localFiles.push({ storageKey, filename, mimeType, size: attachment.size });
          const uploadId = randomUUID();
          await client.query(
            `INSERT INTO uploads(id,user_id,storage_key,filename,mime_type,size_bytes,expected_bytes,status,offset_bytes)
             VALUES($1,$2,$3,$4,$5,$6,$6,'ready',$6)`,
            [uploadId, userId, storageKey, filename, mimeType, attachment.size],
          );
          await client.query(
            `INSERT INTO attachments(message_id,filename,mime_type,size_bytes,storage_key,scanner_state)
             VALUES($1,$2,$3,$4,$5,'unscanned')`,
            [messageId, filename, mimeType, attachment.size, storageKey],
          );
        }
        await client.query(
          "INSERT INTO user_message_state(user_id,message_id,is_read,is_favorite,folder) VALUES($1,$2,FALSE,FALSE,'inbox')",
          [userId, messageId],
        );
        await client.query(
          "INSERT INTO inbound_mail_dedup(recipient_user_id,deduplication_key,message_id) VALUES($1,$2,$3)",
          [userId, dedupe, messageId],
        );
        await recordChange(client, userId, "message", messageId, "created", { conversationId });
        await client.query(
          "INSERT INTO outbox_jobs(kind,payload) VALUES('message.notification',$1::jsonb)",
          [JSON.stringify({ messageId, conversationId, senderUserId: null })],
        );
        await client.query("UPDATE conversations SET updated_at=$2 WHERE id=$1", [conversationId, message.rows[0].created_at]);
        await client.query("DELETE FROM inbound_mail_dedup WHERE ctid IN (SELECT ctid FROM inbound_mail_dedup WHERE received_at < now()-interval '30 days' LIMIT 1000)");
        await client.query("COMMIT");
        for (const file of localFiles) {
          committedPaths.add(join(config.storageDir, file.storageKey));
        }
        committedIds.push(messageId);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        for (const file of localFiles) {
          const fullPath = join(config.storageDir, file.storageKey);
          if (!committedPaths.has(fullPath)) {
            await unlink(fullPath).catch(() => undefined);
            const index = files.indexOf(fullPath);
            if (index >= 0) files.splice(index, 1);
          }
        }
        throw error;
      } finally {
        client.release();
      }
    }
    return committedIds;
  } catch (error) {
    const cleanupTargets = isolateUncommittedAttachmentFiles(files, committedPaths);
    await Promise.all(cleanupTargets.map((file) => unlink(file).catch(() => undefined)));
    throw error;
  }
}

function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

async function readData(stream: SMTPServerDataStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > config.smtp.maxMessageBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge || stream.sizeExceeded) throw smtpError("Message exceeds configured size limit", 552);
  return Buffer.concat(chunks, size);
}

function normalizeRemoteAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

export async function startInboundSmtpServer() {
  if (!config.smtp.inboundEnabled) return null;
  const server = new SMTPServer({
    name: `mx.${config.mailDomain}`,
    size: config.smtp.maxMessageBytes,
    maxClients: config.smtp.inboundMaxClients,
    socketTimeout: 60_000,
    closeTimeout: 10_000,
    disableReverseLookup: true,
    authOptional: !config.smtp.inboundAuthUser,
    ...(config.smtp.inboundTlsKey && config.smtp.inboundTlsCert ? {
      key: require("node:fs").readFileSync(config.smtp.inboundTlsKey),
      cert: require("node:fs").readFileSync(config.smtp.inboundTlsCert),
      secure: true,
    } : { hideSTARTTLS: true }),
    ...(config.smtp.inboundAuthUser ? {
      onAuth(auth, _session, callback) {
        if (auth.username !== config.smtp.inboundAuthUser || auth.password !== config.smtp.inboundAuthPassword) {
          callback(smtpError("Authentication failed", 535));
          return;
        }
        callback(null, { user: auth.username });
      },
    } : {}),
    onConnect(session: SMTPServerSession, callback) {
      if (config.nodeEnv === "production" &&
          !config.smtp.inboundTrustedPeers.includes(normalizeRemoteAddress(session.remoteAddress))) {
        callback(smtpError("Gateway is not trusted", 554));
        return;
      }
      callback();
    },
    onMailFrom(address, _session, callback) {
      if (address.address && /[\r\n\0]/.test(address.address)) {
        callback(smtpError("Invalid envelope sender", 550));
        return;
      }
      if (address.address) {
        try { normalizeEmailAddress(address.address); }
        catch { callback(smtpError("Invalid envelope sender", 550)); return; }
      }
      callback();
    },
    onRcptTo(address, session, callback) {
      let email: string;
      try { email = normalizeEmailAddress(address.address); }
      catch { callback(smtpError("Invalid recipient", 550)); return; }
      if (session.envelope.rcptTo.length >= MAX_INBOUND_RECIPIENTS) {
        callback(smtpError("Recipient limit exceeded", 452));
        return;
      }
      if (!email.endsWith(`@${config.mailDomain}`) || email.includes("\r") || email.includes("\n")) {
        callback(smtpError("This listener does not relay external mail", 550));
        return;
      }
      void query(
        `SELECT 1 FROM addresses a JOIN users u ON u.id=a.user_id
          WHERE lower(a.email)=$1 AND a.is_active AND u.account_status='active'`,
        [email],
      ).then((result) => {
        callback(result.rowCount ? undefined : smtpError("Recipient is unknown or inactive", 550));
      }).catch(() => callback(smtpError("Mailbox lookup temporarily unavailable", 451)));
    },
    onData(stream, session, callback) {
      void (async () => {
        const raw = await readData(stream);
        const envelopeTo = session.envelope.rcptTo.map((recipient) => recipient.address.toLowerCase());
        if (!envelopeTo.length) throw smtpError("No recipients", 554);
        const envelopeFrom = session.envelope.mailFrom && session.envelope.mailFrom.address
          ? normalizeEmailAddress(session.envelope.mailFrom.address)
          : null;
        await acceptedRecipients(raw, envelopeFrom, envelopeTo);
      })().then(
        () => callback(null, "Message durably accepted"),
        (error: unknown) => {
          const status = error && typeof error === "object" && "responseCode" in error
            ? Number((error as { responseCode: unknown }).responseCode)
            : 451;
          callback(smtpError(status >= 500 ? "Message rejected" : "Mailbox temporarily unavailable", status));
        },
      );
    },
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(config.smtp.inboundPort, config.smtp.inboundHost, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  return {
    server,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}

export async function outboundMailCapabilities() {
  if (config.mailTransportMode === "disabled") return { mode: "disabled", configured: false, listenerEnabled: config.smtp.inboundEnabled };
  if (config.mailTransportMode === "file") return { mode: "file_simulation", configured: true, listenerEnabled: config.smtp.inboundEnabled };
  let relayReachable = false;
  try {
    const transport = createConfiguredMailTransport();
    if (transport) {
      const verifier = (transport as MailTransport & { verify?: () => Promise<void> });
      if (config.mailTransportMode === "smtp" && typeof verifier.verify === "function") await verifier.verify();
      relayReachable = true;
      transport.close();
    }
  } catch {
    relayReachable = false;
  }
  return { mode: "smtp", configured: true, listenerEnabled: config.smtp.inboundEnabled, relayReachable };
}
