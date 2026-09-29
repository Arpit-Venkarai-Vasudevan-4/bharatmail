import { createHash, randomUUID } from "node:crypto";
import { config } from "../config";
import { pool, query } from "../db";
import { HttpError } from "../httpError";
import {
  emailFromPhone,
  normalizePhone,
  parseMailboxLocalPart,
  phoneNumberFromPublicIdentity,
} from "../phone";
import { listUserEmails } from "./addressService";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { recordSecurityEvent } from "./securityEventService";
import { assertNotBlocked } from "./contactService";
import { normalizeEmailAddress } from "../email";

export type ConversationFilter = "all" | "unread" | "attachments" | "favorites";

export type ConversationSummary = {
  id: string;
  kind: "direct" | "group";
  members: string[];
  unreadCount: number;
  lastMessage: {
    id: string;
    subject: string;
    body: string;
    senderEmail: string;
    createdAt: string;
  } | null;
  updatedAt: string;
};

export type ConversationPage = {
  conversations: ConversationSummary[];
  hasMore: boolean;
  nextCursor: string | null;
};

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MessageDetail = {
  id: string;
  conversationId: string;
  senderEmail: string;
  subject: string;
  body: string;
  inReplyToId: string | null;
  folder: "inbox" | "drafts" | "spam" | "trash";
  lifecycleStatus: "draft" | "committed" | "failed";
  contentFormat: "plain" | "openpgp-v1";
  createdAt: string;
  recipients: { email: string; role: "to" | "cc" }[];
  attachments: {
    id: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
  }[];
  isRead: boolean;
  isFavorite: boolean;
};

function directPairKey(a: string, b: string): string {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("|");
}

export async function listConversations(
  userId: string,
  filter: ConversationFilter = "all",
  search?: string,
  conversationId?: string,
  limit = 50,
  cursor?: string,
): Promise<ConversationPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "limit must be 1 to 100", "VALIDATION_ERROR");
  }
  const q = (search ?? "").trim();
  let before: { updatedAt: string; id: string } | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        userId?: unknown; filter?: unknown; search?: unknown; updatedAt?: unknown; id?: unknown;
      };
      if (cursor.length > 1024 || decoded.userId !== userId || decoded.filter !== filter ||
          decoded.search !== q || typeof decoded.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(decoded.updatedAt)) || typeof decoded.id !== "string" ||
          !UUID_PATTERN.test(decoded.id)) throw new Error("invalid cursor");
      before = { updatedAt: decoded.updatedAt, id: decoded.id };
    } catch {
      throw new HttpError(400, "Invalid conversation cursor", "INVALID_CURSOR");
    }
  }
  const result = await query<{
    id: string;
    kind: "direct" | "group";
    updated_at: Date;
    cursor_updated_at: string;
    members: string[];
    unread_count: string;
    last_message_id: string | null;
    last_subject: string | null;
    last_body: string | null;
    last_sender: string | null;
    last_created_at: Date | null;
    has_attachments: boolean;
    has_favorite: boolean;
  }>(
    `SELECT
       c.id,
       c.kind,
       c.updated_at,
       c.updated_at::text AS cursor_updated_at,
       ARRAY(
         SELECT COALESCE(primary_address.email, cm.email)
         FROM conversation_members cm
         LEFT JOIN addresses primary_address ON primary_address.user_id = cm.user_id AND primary_address.is_primary
         WHERE cm.conversation_id = c.id
         ORDER BY COALESCE(primary_address.email, cm.email)
       ) AS members,
       (
         SELECT COUNT(*)::int FROM messages m
         LEFT JOIN user_message_state ums
           ON ums.message_id = m.id AND ums.user_id = $1
         WHERE m.conversation_id = c.id
           AND COALESCE(ums.folder, m.folder) = 'inbox'
           AND (m.sender_user_id IS DISTINCT FROM $1)
           AND COALESCE(ums.is_read, FALSE) = FALSE
       ) AS unread_count,
       lm.id AS last_message_id,
       left(lm.subject, 200) AS last_subject,
       left(lm.body, 240) AS last_body,
       lm.sender_email AS last_sender,
       lm.created_at AS last_created_at,
       EXISTS (
         SELECT 1 FROM messages m
         JOIN attachments a ON a.message_id = m.id
         WHERE m.conversation_id = c.id
           AND m.folder <> 'drafts'
           AND COALESCE((SELECT folder FROM user_message_state WHERE user_id = $1 AND message_id = m.id), m.folder) = 'inbox'
       ) AS has_attachments,
       EXISTS (
         SELECT 1 FROM messages m
         JOIN user_message_state ums ON ums.message_id = m.id
         WHERE m.conversation_id = c.id AND ums.user_id = $1 AND ums.is_favorite = TRUE
       ) AS has_favorite
     FROM conversations c
     LEFT JOIN LATERAL (
       SELECT m.id, m.subject, m.body, m.sender_email, m.created_at
       FROM messages m
       WHERE m.conversation_id = c.id
         AND m.folder <> 'drafts'
         AND (m.sender_user_id = $1 OR COALESCE((SELECT folder FROM user_message_state WHERE user_id = $1 AND message_id = m.id), m.folder) = 'inbox')
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON TRUE
     WHERE ($2::uuid IS NULL OR c.id = $2::uuid)
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM conversation_members search_members
         LEFT JOIN addresses search_primary ON search_primary.user_id = search_members.user_id AND search_primary.is_primary
         WHERE search_members.conversation_id = c.id
           AND COALESCE(search_primary.email, search_members.email) ILIKE '%' || $3 || '%'
       ) OR EXISTS (
         SELECT 1 FROM messages search_messages
         WHERE search_messages.conversation_id = c.id
           AND search_messages.folder <> 'drafts'
           AND (COALESCE((SELECT folder FROM user_message_state WHERE user_id = $1 AND message_id = search_messages.id), search_messages.folder) = 'inbox')
           AND (search_messages.subject ILIKE '%' || $3 || '%'
             OR search_messages.body ILIKE '%' || $3 || '%'
             OR search_messages.sender_email ILIKE '%' || $3 || '%')
       ))
       AND EXISTS (
       SELECT 1 FROM conversation_members cm
       WHERE cm.conversation_id = c.id AND cm.user_id = $1
     )
       AND ($4::text <> 'unread' OR EXISTS (
         SELECT 1 FROM messages um
         LEFT JOIN user_message_state uus ON uus.message_id = um.id AND uus.user_id = $1
         WHERE um.conversation_id = c.id
           AND um.sender_user_id IS DISTINCT FROM $1
           AND um.folder <> 'drafts'
           AND COALESCE(uus.folder, um.folder) = 'inbox'
           AND COALESCE(uus.is_read, FALSE) = FALSE
       ))
       AND ($4::text <> 'attachments' OR EXISTS (
         SELECT 1 FROM messages am JOIN attachments aa ON aa.message_id = am.id
         WHERE am.conversation_id = c.id
           AND am.folder <> 'drafts'
           AND (am.sender_user_id = $1 OR EXISTS (
             SELECT 1 FROM message_recipients arm
             WHERE arm.message_id = am.id AND arm.recipient_user_id = $1
           ))
       ))
       AND ($4::text <> 'favorites' OR EXISTS (
         SELECT 1 FROM user_message_state fms
         JOIN messages fm ON fm.id = fms.message_id
         WHERE fms.user_id = $1 AND fms.is_favorite = TRUE AND fm.conversation_id = c.id
       ))
       AND ($5::timestamptz IS NULL OR (c.updated_at,c.id) < ($5::timestamptz,$6::uuid))
     ORDER BY c.updated_at DESC,c.id DESC
     LIMIT $7`,
    [userId, conversationId ?? null, q || null, filter, before?.updatedAt ?? null, before?.id ?? null, limit + 1]
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const conversations = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      members: row.members,
      unreadCount: Number(row.unread_count),
      lastMessage: row.last_message_id
        ? {
            id: row.last_message_id,
            subject: row.last_subject ?? "",
            body: row.last_body ?? "",
            senderEmail: row.last_sender ?? "",
            createdAt: row.last_created_at!.toISOString(),
          }
        : null,
      updatedAt: row.updated_at.toISOString(),
    }));
  const last = rows.at(-1);
  return {
    conversations,
    hasMore,
    nextCursor: hasMore && last
      ? Buffer.from(JSON.stringify({
          userId, filter, search: q,
          updatedAt: last.cursor_updated_at, id: last.id,
        })).toString("base64url")
      : null,
  };
}

export async function updateMessageState(
  userId: string,
  conversationId: string,
  messageId: string,
  input: { isRead?: boolean; isFavorite?: boolean; folder?: "inbox" | "sent" | "drafts" | "spam" | "trash" | "archive" }
): Promise<void> {
  await assertMember(userId, conversationId);
  if (!UUID_PATTERN.test(messageId)) throw new HttpError(400, "message id must be a UUID");
  if (input.folder && !["inbox", "sent", "drafts", "spam", "trash", "archive"].includes(input.folder)) {
    throw new HttpError(400, "folder is not a supported mailbox", "VALIDATION_ERROR");
  }
  const exists = await query<{ folder: string; sender_user_id: string }>("SELECT folder, sender_user_id FROM messages WHERE id = $1 AND conversation_id = $2", [messageId, conversationId]);
  if ((exists.rowCount ?? 0) === 0) throw new HttpError(404, "Message not found");
  if (exists.rows[0].folder === "drafts" && exists.rows[0].sender_user_id !== userId) {
    throw new HttpError(404, "Message not found", "NOT_FOUND");
  }
  if (input.folder === "drafts") {
    const owned = await query(
      "SELECT 1 FROM messages WHERE id = $1 AND sender_user_id = $2 AND folder = 'drafts'",
      [messageId, userId]
    );
    if ((owned.rowCount ?? 0) === 0) {
      throw new HttpError(403, "Only an owned unsent draft can use the drafts folder", "FORBIDDEN");
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    await client.query(
    `INSERT INTO user_message_state (user_id, message_id, is_read, is_favorite, folder)
     VALUES ($1, $2, COALESCE($3, FALSE), COALESCE($4, FALSE), COALESCE($5, 'inbox'))
     ON CONFLICT (user_id, message_id) DO UPDATE SET
       is_read = COALESCE($3, user_message_state.is_read),
       is_favorite = COALESCE($4, user_message_state.is_favorite),
       folder = COALESCE($5, user_message_state.folder)`,
      [userId, messageId, input.isRead ?? null, input.isFavorite ?? null, input.folder ?? null]
    );
    await recordChange(client, userId, "message_state", messageId, "updated", input);
    if (input.folder === "trash") {
      await recordSecurityEvent(client, {
        userId,
        eventType: "message_deleted",
        metadata: { resourceId: messageId },
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMailbox(
  userId: string,
  folder: "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam",
  limit = 20,
  cursor?: string,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "limit must be 1 to 100", "VALIDATION_ERROR");
  let before: { createdAt: string; entityType: "draft" | "message"; id: string } | null = null;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        userId?: unknown; folder?: unknown; createdAt?: unknown; entityType?: unknown; id?: unknown;
      };
      if (decoded.userId !== userId || decoded.folder !== folder ||
          typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt)) ||
          (decoded.entityType !== "draft" && decoded.entityType !== "message") ||
          typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id) || cursor.length > 1024) throw new Error("invalid cursor");
      before = { createdAt: decoded.createdAt, entityType: decoded.entityType, id: decoded.id };
    } catch {
      throw new HttpError(400, "Invalid mailbox cursor", "INVALID_CURSOR");
    }
  }
  const result = await query<{
    id: string; entity_type: "draft" | "message"; conversation_id: string | null; sender_email: string;
    subject: string; body: string; sort_at: Date; cursor_sort_at: string; is_read: boolean; is_favorite: boolean;
  }>(
    `WITH entries AS (
       SELECT m.id,'message'::text AS entity_type,m.conversation_id,m.sender_email,
              left(m.subject,200) AS subject,left(m.body,240) AS body,m.created_at AS sort_at,
              COALESCE(ums.is_read,FALSE) AS is_read,COALESCE(ums.is_favorite,FALSE) AS is_favorite
         FROM messages m
         JOIN user_message_state ums ON ums.message_id=m.id AND ums.user_id=$1
        WHERE ums.folder=$2 AND (m.folder <> 'drafts' OR m.sender_user_id=$1)
       UNION ALL
       SELECT d.id,'draft'::text AS entity_type,NULL::uuid,
              COALESCE(a.email,'') AS sender_email,left(d.subject,200),left(d.body,240),d.updated_at,
              TRUE,FALSE
         FROM drafts d
         LEFT JOIN addresses a ON a.user_id=d.user_id AND a.is_primary
        WHERE $2='drafts' AND d.user_id=$1
     )
     SELECT id,entity_type,conversation_id,sender_email,subject,body,sort_at,sort_at::text AS cursor_sort_at,is_read,is_favorite
       FROM entries
      WHERE ($3::timestamptz IS NULL OR (sort_at,entity_type,id) < ($3::timestamptz,$4::text,$5::uuid))
      ORDER BY sort_at DESC,entity_type DESC,id DESC LIMIT $6`,
    [userId, folder, before?.createdAt ?? null, before?.entityType ?? null, before?.id ?? null, limit + 1]
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const messages = rows.map((row) => ({
    id: row.id, entityType: row.entity_type, conversationId: row.conversation_id, senderEmail: row.sender_email,
    subject: row.subject, body: row.body, createdAt: row.sort_at.toISOString(),
    isRead: row.is_read, isFavorite: row.is_favorite,
  }));
  const last = rows.at(-1);
  return {
    messages,
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
      userId,
      folder,
      createdAt: last.cursor_sort_at,
      entityType: last.entity_type,
      id: last.id,
    })).toString("base64url") : null,
  };
}

export async function searchMessages(userId: string, search: string, limit = 25, cursor?: string) {
  const q = search.trim();
  if (q.length < 2 || q.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new HttpError(400, "q must be 2 to 200 characters and limit must be 1 to 50", "VALIDATION_ERROR");
  }
  let before: { createdAt: string; id: string } | undefined;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { userId?: unknown; search?: unknown; createdAt?: unknown; id?: unknown };
      if (cursor.length > 1024 || decoded.userId !== userId || decoded.search !== q ||
          typeof decoded.createdAt !== "string" || !Number.isFinite(Date.parse(decoded.createdAt)) ||
          typeof decoded.id !== "string" || !UUID_PATTERN.test(decoded.id)) throw new Error("invalid cursor");
      before = { createdAt: decoded.createdAt, id: decoded.id };
    } catch {
      throw new HttpError(400, "Invalid message search cursor", "INVALID_CURSOR");
    }
  }
  const result = await query<{
    id: string; conversation_id: string; subject: string; snippet: string; sender_email: string;
    created_at: Date; cursor_created_at: string; folder: string; is_read: boolean; is_favorite: boolean;
  }>(
    `SELECT m.id,m.conversation_id,left(m.subject,200) AS subject,left(m.body,240) AS snippet,
            m.sender_email,m.created_at,m.created_at::text AS cursor_created_at,
            COALESCE(ums.folder,m.folder) AS folder,COALESCE(ums.is_read,FALSE) AS is_read,
            COALESCE(ums.is_favorite,FALSE) AS is_favorite
       FROM messages m
       LEFT JOIN user_message_state ums ON ums.message_id=m.id AND ums.user_id=$1
      WHERE (m.sender_user_id=$1 OR EXISTS(
              SELECT 1 FROM message_recipients mr WHERE mr.message_id=m.id AND mr.recipient_user_id=$1
            ))
        AND (m.sender_user_id=$1 OR (m.folder <> 'drafts' AND COALESCE(ums.folder,m.folder) <> 'drafts'))
        AND (m.subject ILIKE '%' || $2 || '%' OR m.body ILIKE '%' || $2 || '%' OR m.sender_email ILIKE '%' || $2 || '%'
             OR EXISTS(SELECT 1 FROM message_recipients mr WHERE mr.message_id=m.id AND mr.email ILIKE '%' || $2 || '%'))
        AND ($3::timestamptz IS NULL OR (m.created_at,m.id) < ($3::timestamptz,$4::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $5`,
    [userId,q,before?.createdAt ?? null,before?.id ?? null,limit+1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0,limit);
  const last = rows.at(-1);
  return {
    messages: rows.map((row) => ({
      id: row.id, conversationId: row.conversation_id, subject: row.subject, snippet: row.snippet,
      senderEmail: row.sender_email, createdAt: row.created_at.toISOString(), folder: row.folder,
      isRead: row.is_read, isFavorite: row.is_favorite,
    })),
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
      userId, search: q, createdAt: last.cursor_created_at, id: last.id,
    })).toString("base64url") : null,
  };
}

export async function createConversation(
  userId: string,
  participantPhones: string[],
  country?: string,
): Promise<ConversationSummary> {
  const myEmails = await listUserEmails(userId);
  const primary = myEmails.find((e) => e.endsWith(`@${config.mailDomain}`));
  if (!primary) {
    throw new HttpError(400, "User has no mailbox address");
  }

  const requested = await Promise.all(participantPhones.map(async (value) => {
    const trimmed = String(value).trim();
    if (trimmed.includes("@")) {
      const local = parseMailboxLocalPart(trimmed, config.mailDomain);
      if (!local) {
        throw new HttpError(400, "Only PhoneMail addresses are supported");
      }
      const address = await query<{ email: string }>(
        `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
          WHERE a.email=$1 AND a.is_active AND u.account_status='active'`,
        [`${local}@${config.mailDomain}`],
      );
      if (!address.rows[0]) throw new HttpError(404, "Recipient address is not registered");
      return address.rows[0].email;
    }
    let normalized: string;
    if (country || trimmed.startsWith("+") || trimmed.startsWith("00")) {
      normalized = normalizePhone(trimmed, country ?? (config.phoneDefaultCountry || undefined));
    } else {
      const publicDigits = phoneNumberFromPublicIdentity(trimmed);
      const publicAddress = emailFromPhone(publicDigits, config.mailDomain);
      const known = await query<{ email: string }>(
        `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
          WHERE a.email=$1 AND a.is_active AND u.account_status='active'`,
        [publicAddress],
      );
      if (known.rows[0]) return known.rows[0].email;
      try {
        normalized = normalizePhone(trimmed, config.phoneDefaultCountry || undefined);
      } catch (error) {
        if (error instanceof HttpError && error.code === "PHONE_INVALID") {
          throw new HttpError(404, "Recipient phone is not registered");
        }
        throw error;
      }
    }
    const email = emailFromPhone(normalized, config.mailDomain);
    const address = await query<{ email: string }>(
      `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
        WHERE a.email=$1 AND a.is_active AND u.account_status='active'`,
      [email],
    );
    if (!address.rows[0]) throw new HttpError(404, "Recipient phone is not registered");
    return address.rows[0].email;
  }));
  const others = [...new Set(requested)].filter((e) => !myEmails.includes(e));
  if (others.length === 0) {
    throw new HttpError(400, "Add at least one other recipient");
  }
  const recipientIds = await query<{ user_id: string }>(
    "SELECT DISTINCT a.user_id FROM addresses a JOIN users u ON u.id=a.user_id WHERE a.email=ANY($1::text[]) AND a.is_active AND u.account_status='active'",
    [others],
  );

  const kind = others.length === 1 ? "direct" : "group";
  const memberEmails = [primary, ...others];

  const client = await pool.connect();
  let committedConversationId: string | undefined;
  try {
    await client.query("BEGIN");
    const memberUserIds = [userId, ...recipientIds.rows.map((row) => row.user_id)];
    await lockChangeAccounts(client, memberUserIds);
    await assertNotBlocked(userId, recipientIds.rows.map((row) => row.user_id), client);

    let conversationId: string;
    let createdNow = false;

    if (kind === "direct") {
      const key = directPairKey(primary, others[0]);
      const existingByUsers = await client.query<{ id: string }>(
        `SELECT c.id FROM conversations c
          WHERE c.kind='direct'
            AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=$1)
            AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=$2)
          ORDER BY c.created_at,c.id LIMIT 1`,
        [userId, recipientIds.rows[0].user_id],
      );
      const existingByAddress = existingByUsers.rows[0] ? { rows: [] as { id: string }[] } : await client.query<{ id: string }>(
        "SELECT id FROM conversations WHERE kind = 'direct' AND direct_pair_key = $1",
        [key]
      );
      const existing = existingByUsers.rows[0] ?? existingByAddress.rows[0];
      if (existing) {
        conversationId = existing.id;
      } else {
        let created;
        await client.query("SAVEPOINT direct_conversation_insert");
        try {
          created = await client.query<{ id: string }>(
            `INSERT INTO conversations (kind, direct_pair_key)
             VALUES ('direct', $1)
             RETURNING id`,
            [key]
          );
          await client.query("RELEASE SAVEPOINT direct_conversation_insert");
        } catch (err) {
          if (!(err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505")) {
            throw err;
          }
          await client.query("ROLLBACK TO SAVEPOINT direct_conversation_insert");
          await client.query("RELEASE SAVEPOINT direct_conversation_insert");
          created = await client.query<{ id: string }>(
            "SELECT id FROM conversations WHERE kind = 'direct' AND direct_pair_key = $1",
            [key]
          );
        }
        conversationId = created.rows[0].id;
        createdNow = true;
        if (created.rows[0] && (await client.query("SELECT 1 FROM conversation_members WHERE conversation_id = $1 LIMIT 1", [conversationId])).rowCount === 0) {
          for (const email of memberEmails) {
          const userRow = await client.query<{ user_id: string }>(
            "SELECT user_id FROM addresses WHERE email = $1",
            [email]
          );
          await client.query(
            `INSERT INTO conversation_members (conversation_id, email, user_id)
             VALUES ($1, $2, $3)`,
            [conversationId, email, userRow.rows[0]?.user_id ?? null]
          );
          }
        }
      }
    } else {
      const created = await client.query<{ id: string }>(
        `INSERT INTO conversations (kind) VALUES ('group') RETURNING id`
      );
      conversationId = created.rows[0].id;
      createdNow = true;
      for (const email of memberEmails) {
        const userRow = await client.query<{ user_id: string }>(
          "SELECT user_id FROM addresses WHERE email = $1",
          [email]
        );
        await client.query(
          `INSERT INTO conversation_members (conversation_id, email, user_id)
           VALUES ($1, $2, $3)`,
          [conversationId, email, userRow.rows[0]?.user_id ?? null]
        );
      }
    }

    if (createdNow) {
      for (const memberId of [...new Set(memberUserIds)].sort()) {
        await recordChange(client, memberId, "conversation", conversationId, "upserted", { id: conversationId, kind });
      }
    }
    await client.query("COMMIT");
    committedConversationId = conversationId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  const listed = await listConversations(userId, "all", undefined, committedConversationId, 1);
  const found = listed.conversations.find((conversation) => conversation.id === committedConversationId);
  if (!found) {
    throw new HttpError(500, "Conversation was created but could not be loaded");
  }
  return found;
}

async function assertMember(userId: string, conversationId: string): Promise<string[]> {
  if (!UUID_PATTERN.test(conversationId)) throw new HttpError(400, "conversation id must be a UUID");
  const result = await query<{ email: string }>(
    `SELECT a.email FROM conversation_members cm
       JOIN users u ON u.id=cm.user_id
       JOIN addresses a ON a.user_id=u.id AND a.is_active
      WHERE cm.conversation_id=$1 AND cm.user_id=$2 AND u.account_status='active'
      ORDER BY a.is_primary DESC,a.created_at`,
    [conversationId, userId]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new HttpError(404, "Conversation not found");
  }
  return result.rows.map((row) => row.email);
}

export async function getConversation(
  userId: string,
  conversationId: string,
  page = 1,
  pageSize = 50
): Promise<{ conversation: ConversationSummary; messages: MessageDetail[]; pagination: { page: number; pageSize: number; hasMore: boolean } }> {
  page = Math.max(1, page);
  pageSize = Math.min(100, Math.max(1, pageSize));
  await assertMember(userId, conversationId);
  const listed = await listConversations(userId, "all", undefined, conversationId, 1);
  const conversation = listed.conversations.find((c) => c.id === conversationId);
  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }

  const messageRows = await query<{
    id: string;
    conversation_id: string;
    sender_email: string;
    subject: string;
    body: string;
    in_reply_to_id: string | null;
    viewer_folder: "inbox" | "drafts" | "spam" | "trash";
    lifecycle_status: "draft" | "committed" | "failed";
    content_format: "plain" | "openpgp-v1";
    created_at: Date;
    is_read: boolean | null;
    is_favorite: boolean | null;
  }>(
    `SELECT m.*, COALESCE(ums.is_read, FALSE) AS is_read,
            COALESCE(ums.is_favorite, FALSE) AS is_favorite,
            COALESCE(ums.folder, m.folder) AS viewer_folder
     FROM messages m
     LEFT JOIN user_message_state ums
       ON ums.message_id = m.id AND ums.user_id = $2
     WHERE m.conversation_id = $1
       AND (m.sender_user_id = $2 OR (m.folder <> 'drafts' AND COALESCE(ums.folder, m.folder) <> 'drafts'))
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $3 OFFSET $4`,
    [conversationId, userId, pageSize + 1, (page - 1) * pageSize]
  );
  const hasMore = messageRows.rows.length > pageSize;
  messageRows.rows = messageRows.rows.slice(0, pageSize).reverse();

  const ids = messageRows.rows.map((m) => m.id);
  const recipients =
    ids.length === 0
      ? { rows: [] as { message_id: string; email: string; role: "to" | "cc" }[] }
      : await query<{ message_id: string; email: string; role: "to" | "cc" }>(
          `SELECT message_id, email, role FROM message_recipients WHERE message_id = ANY($1::uuid[])`,
          [ids]
        );
  const attachments =
    ids.length === 0
      ? {
          rows: [] as {
            id: string;
            message_id: string;
            filename: string;
            mime_type: string;
            size_bytes: number;
            storage_key: string;
            scanner_state: string;
          }[],
        }
      : await query<{
          id: string;
          message_id: string;
          filename: string;
          mime_type: string;
          size_bytes: number;
          storage_key: string;
          scanner_state: string;
        }>(
          `SELECT a.id, a.message_id, a.filename, a.mime_type, a.size_bytes, a.storage_key, a.scanner_state
           FROM attachments a JOIN messages m ON m.id = a.message_id
           WHERE a.message_id = ANY($1::uuid[])
             AND (m.sender_user_id = $2 OR EXISTS (
               SELECT 1 FROM message_recipients mr
               WHERE mr.message_id = a.message_id AND mr.recipient_user_id = $2
             ))`,
          [ids, userId]
        );

  const messages: MessageDetail[] = messageRows.rows.map((m) => ({
    id: m.id,
    conversationId: m.conversation_id,
    senderEmail: m.sender_email,
    subject: m.subject,
    body: m.body,
    inReplyToId: m.in_reply_to_id,
    folder: m.viewer_folder,
    lifecycleStatus: m.lifecycle_status,
    contentFormat: m.content_format,
    createdAt: m.created_at.toISOString(),
    recipients: recipients.rows
      .filter((r) => r.message_id === m.id)
      .map((r) => ({ email: r.email, role: r.role })),
    attachments: attachments.rows
      .filter((a) => a.message_id === m.id)
      .map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        storageKey: a.storage_key,
        scanStatus: a.scanner_state,
      })),
    isRead: m.is_read ?? false,
    isFavorite: m.is_favorite ?? false,
  }));

  return { conversation, messages, pagination: { page, pageSize, hasMore } };
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  input: {
    subject?: string;
    body: string;
    to?: string[];
    cc?: string[];
    inReplyToId?: string;
    folder?: "inbox" | "drafts";
    idempotencyKey?: string;
    requestHash?: string;
  }
): Promise<MessageDetail> {
  const myEmails = await assertMember(userId, conversationId);
  const senderEmail = myEmails[0];
  const idempotencyKey = input.idempotencyKey;
  const requestHash = input.requestHash;
  if (idempotencyKey && requestHash) {
    const existingKey = await query<{ request_hash: string; resource_id: string; expires_at: string }>(
      `SELECT request_hash, resource_id, expires_at
         FROM idempotency_keys
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    if (existingKey.rows[0]) {
      if (new Date(existingKey.rows[0].expires_at).getTime() <= Date.now()) {
        throw new HttpError(409, "Idempotency key has expired; use a new durable operation key", "IDEMPOTENCY_EXPIRED");
      }
      if (existingKey.rows[0].request_hash !== requestHash) {
        throw new HttpError(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT");
      }
      return getMessage(userId, conversationId, existingKey.rows[0].resource_id);
    }
  }
  if (input.inReplyToId && !UUID_PATTERN.test(input.inReplyToId)) {
    throw new HttpError(400, "inReplyToId must be a UUID");
  }
  if (input.to !== undefined && (!Array.isArray(input.to) || input.to.length > 50) ||
      input.cc !== undefined && (!Array.isArray(input.cc) || input.cc.length > 50)) {
    throw new HttpError(400, "recipient lists must contain at most 50 items");
  }

  if (input.inReplyToId) {
    const parent = await query<{ id: string; subject: string }>(
      `SELECT id, subject FROM messages WHERE id = $1 AND conversation_id = $2
       AND (sender_user_id = $3 OR EXISTS (
         SELECT 1 FROM user_message_state WHERE user_id = $3 AND message_id = messages.id
       ))`,
      [input.inReplyToId, conversationId, userId]
    );
    if ((parent.rowCount ?? 0) === 0) {
      throw new HttpError(400, "Original message not found in this conversation");
    }
    const reply = await query(
      `SELECT id FROM messages WHERE in_reply_to_id = $1`,
      [input.inReplyToId]
    );
    if ((reply.rowCount ?? 0) > 0) {
      throw new HttpError(409, "This message has already been replied to");
    }
  }

  const members = await query<{ email: string; user_id: string | null }>(
    `SELECT email, user_id FROM conversation_members WHERE conversation_id = $1`,
    [conversationId]
  );
  const otherMemberIds = [...new Set(members.rows.map((member) => member.user_id).filter((id): id is string => Boolean(id) && id !== userId))];
  const currentRecipientAddresses = otherMemberIds.length
    ? await query<{ email: string }>("SELECT email FROM addresses WHERE user_id = ANY($1::uuid[]) AND is_primary", [otherMemberIds])
    : { rows: [] as { email: string }[] };
  const defaultTo = currentRecipientAddresses.rows.map((row) => row.email).sort();
  const initialRecipients = await query<{ email: string; role: "to" | "cc"; recipient_user_id: string | null }>(
    `WITH first_message AS (
       SELECT id FROM messages
        WHERE conversation_id = $1 AND folder <> 'drafts'
        ORDER BY created_at ASC, id ASC
        LIMIT 1
     )
     SELECT DISTINCT ON (COALESCE(mr.recipient_user_id::text, cm.user_id::text, lower(mr.email)), mr.role)
            COALESCE(primary_address.email, mr.email) AS email, mr.role,
            COALESCE(mr.recipient_user_id, cm.user_id) AS recipient_user_id
       FROM message_recipients mr
       JOIN first_message fm ON fm.id = mr.message_id
       JOIN messages first_message_row ON first_message_row.id = mr.message_id
       LEFT JOIN conversation_members cm
         ON cm.conversation_id = first_message_row.conversation_id AND cm.email = mr.email
       LEFT JOIN addresses primary_address
         ON primary_address.user_id = COALESCE(mr.recipient_user_id, cm.user_id) AND primary_address.is_primary
      WHERE (COALESCE(mr.recipient_user_id, cm.user_id) IS NULL
          OR COALESCE(mr.recipient_user_id, cm.user_id) <> $2::uuid)
        AND lower(mr.email) <> lower($3::text)
      ORDER BY COALESCE(mr.recipient_user_id::text, cm.user_id::text, lower(mr.email)), mr.role`,
    [conversationId, userId, senderEmail]
  );
  const storedTo = initialRecipients.rows.filter((row) => row.role === "to" && row.recipient_user_id !== userId).map((row) => row.email);
  const storedCc = initialRecipients.rows.filter((row) => row.role === "cc" && row.recipient_user_id !== userId).map((row) => row.email);
  const expectedTo = [...new Set([...storedTo, ...defaultTo])].sort();
  const expectedCc = storedCc.sort();
  const to = await normalizeRecipients(input.to && input.to.length > 0 ? input.to : expectedTo);
  const cc = await normalizeRecipients(input.cc ?? expectedCc);
  if (input.to !== undefined || input.cc !== undefined) {
    if (to.slice().sort().join("|") !== expectedTo.join("|") || cc.join("|") !== expectedCc.join("|")) {
      throw new HttpError(400, "Recipients cannot be changed inside an existing conversation");
    }
  }
  if (input.folder && !["inbox", "drafts"].includes(input.folder)) {
    throw new HttpError(400, "folder must be inbox or drafts");
  }

  const client = await pool.connect();
  let messageId = "";
  let parentSubject = "";
  let parentRfcMessageId: string | null = null;
  let parentReferences: string[] = [];
  try {
    await client.query("BEGIN");
    const recipientsForLock = (input.folder ?? "inbox") === "drafts"
      ? { rows: [] as { id: string }[] }
      : await client.query<{ id: string }>(
        "SELECT DISTINCT a.user_id AS id FROM addresses a WHERE a.email=ANY($1::text[]) AND a.is_active AND a.user_id IS NOT NULL",
        [[...to, ...cc]],
      );
    if ((input.folder ?? "inbox") !== "drafts") {
      await lockChangeAccounts(client, [userId, ...recipientsForLock.rows.map((recipient) => recipient.id)]);
      await assertNotBlocked(userId, recipientsForLock.rows.map((recipient) => recipient.id), client);
    } else {
      await lockChangeAccounts(client, [userId]);
    }
    if (input.inReplyToId) {
      const parent = await client.query<{ subject: string; rfc_message_id: string | null; references_header: string[] }>(
        "SELECT subject,rfc_message_id,references_header FROM messages WHERE id = $1",
        [input.inReplyToId],
      );
      parentSubject = parent.rows[0]?.subject ?? "";
      parentRfcMessageId = parent.rows[0]?.rfc_message_id ?? null;
      parentReferences = parent.rows[0]?.references_header ?? [];
    }
    if (idempotencyKey && requestHash) {
      messageId = randomUUID();
      const insertedKey = await client.query(
        `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, resource_type, resource_id, expires_at)
         VALUES ($1, $2, $3, 'message', $4, now() + interval '24 hours')
         ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
        [userId, idempotencyKey, requestHash, messageId]
      );
      if ((insertedKey.rowCount ?? 0) === 0) {
        const existing = await client.query<{ request_hash: string; resource_id: string }>(
          "SELECT request_hash, resource_id FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > now()",
          [userId, idempotencyKey]
        );
        if (!existing.rows[0] || existing.rows[0].request_hash !== requestHash) {
          throw new HttpError(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT");
        }
        await client.query("COMMIT");
        return getMessage(userId, conversationId, existing.rows[0].resource_id);
      }
    } else {
      messageId = randomUUID();
    }
    const rfcMessageId = `<${messageId}@${config.mailDomain}>`;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (
         id, conversation_id, sender_email, sender_user_id, subject, body, in_reply_to_id, folder, lifecycle_status,rfc_message_id,references_header
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8='drafts' THEN 'draft' ELSE 'committed' END,$9,$10)
       RETURNING id`,
      [
        messageId,
        conversationId,
        senderEmail,
        userId,
        input.inReplyToId ? parentSubject : (input.subject ?? ""),
        input.body ?? "",
        input.inReplyToId ?? null,
        input.folder ?? "inbox",
        rfcMessageId,
        input.inReplyToId
          ? [...new Set([...parentReferences, ...(parentRfcMessageId ? [parentRfcMessageId] : [])])]
          : [],
      ]
    );
    messageId = inserted.rows[0].id;

    const recipientIdentityRows = await client.query<{
      email: string; user_id: string | null; is_active: boolean; account_status: string | null;
    }>(
      `SELECT a.email,a.user_id,a.is_active,u.account_status
         FROM addresses a LEFT JOIN users u ON u.id=a.user_id
        WHERE a.email=ANY($1::text[])`,
      [[...to, ...cc]],
    );
    const recipientIdentity = new Map(recipientIdentityRows.rows.map((row) => [
      row.email.toLowerCase(),
      { userId: row.user_id, active: row.is_active && row.account_status === "active" },
    ]));
    for (const email of [...to, ...cc]) {
      const identity = recipientIdentity.get(email.toLowerCase());
      if (email.endsWith(`@${config.mailDomain}`) && (!identity?.userId || !identity.active)) {
        throw new HttpError(409, "Recipient address changed; resolve recipients again", "RECIPIENT_UNAVAILABLE");
      }
    }
    for (const email of to) {
      await client.query(
        `INSERT INTO message_recipients (message_id, email, role, recipient_user_id) VALUES ($1, $2, 'to', $3)`,
        [messageId, email, recipientIdentity.get(email.toLowerCase())?.userId ?? null]
      );
    }
    for (const email of cc) {
      await client.query(
        `INSERT INTO message_recipients (message_id, email, role, recipient_user_id) VALUES ($1, $2, 'cc', $3)`,
        [messageId, email, recipientIdentity.get(email.toLowerCase())?.userId ?? null]
      );
    }

    await client.query(
      `INSERT INTO user_message_state (user_id, message_id, is_read, is_favorite, folder)
       VALUES ($1, $2, TRUE, FALSE, $3)`,
      [userId, messageId, input.folder === "drafts" ? "drafts" : input.folder === "inbox" ? "inbox" : input.folder ?? "sent"]
    );
    if ((input.folder ?? "inbox") !== "drafts") {
      for (const recipient of recipientsForLock.rows) {
        await client.query(
          `INSERT INTO user_message_state (user_id, message_id, is_read, is_favorite, folder)
           VALUES ($1, $2, FALSE, FALSE, 'inbox')
           ON CONFLICT (user_id, message_id) DO NOTHING`,
          [recipient.id, messageId]
        );
        await client.query(
          "INSERT INTO message_deliveries(message_id,recipient_user_id,status) VALUES($1,$2,'local_committed')",
          [messageId, recipient.id],
        );
      }
    }
    const externalRoles = new Map<string, "to" | "cc">(to.map((email) => [email, "to"]));
    for (const email of cc) if (!externalRoles.has(email)) externalRoles.set(email, "cc");
    const externalAddresses = [...externalRoles.keys()].filter((email) => !email.endsWith(`@${config.mailDomain}`));
    if ((input.folder ?? "inbox") !== "drafts") {
      for (const email of externalAddresses) {
        await client.query(
          "INSERT INTO smtp_message_deliveries(message_id,recipient_email,role,status) VALUES($1,$2,$3,'queued')",
          [messageId, email, externalRoles.get(email)],
        );
      }
    }

    await client.query(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [
      conversationId,
    ]);
    await recordChange(client, userId, "message", messageId, "created", { conversationId });
    if ((input.folder ?? "inbox") !== "drafts") {
      for (const recipient of recipientsForLock.rows) {
        await recordChange(client, recipient.id, "message", messageId, "created", { conversationId });
      }
      if (recipientsForLock.rows.length) {
        await client.query(
          `INSERT INTO outbox_jobs (kind, payload) VALUES ('message.notification', $1::jsonb)`,
          [JSON.stringify({ messageId, conversationId, senderUserId: userId })],
        );
      }
      if (externalAddresses.length) {
        await client.query(
          "INSERT INTO outbox_jobs(kind,payload) VALUES('message.smtp-delivery',$1::jsonb)",
          [JSON.stringify({ messageId })],
        );
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
      throw new HttpError(409, "This message has already been replied to");
    }
    throw err;
  } finally {
    client.release();
  }

  return getMessage(userId, conversationId, messageId);
}

export async function sendDraft(
  userId: string,
  draftId: string,
  input: {
    conversationId?: string;
    revision: number;
    attachmentIds: string[];
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<MessageDetail> {
  if (!UUID_PATTERN.test(draftId) || (input.conversationId && !UUID_PATTERN.test(input.conversationId))) {
    throw new HttpError(400, "draft and conversation ids must be UUIDs", "VALIDATION_ERROR");
  }
  const myEmails = input.conversationId
    ? await assertMember(userId, input.conversationId)
    : (await query<{ email: string }>(
      `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
        WHERE a.user_id=$1 AND a.is_primary AND a.is_active AND u.account_status='active'`,
      [userId],
    )).rows.map((row) => row.email);
  if (!myEmails.length) throw new HttpError(403, "No active primary PhoneMail address is available", "ADDRESS_UNAVAILABLE");
  const senderEmail = myEmails[0];
  let conversationId = input.conversationId;
  const attachmentIds = [...new Set(input.attachmentIds)];
  if (attachmentIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new HttpError(400, "attachmentIds must contain UUIDs", "VALIDATION_ERROR");
  }

  const client = await pool.connect();
  let messageId = "";
  let clientReleased = false;
  try {
    await client.query("BEGIN");

    const existingKey = await client.query<{ request_hash: string; resource_id: string }>(
      `SELECT request_hash, resource_id
         FROM idempotency_keys
        WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > now()
        FOR UPDATE`,
      [userId, input.idempotencyKey],
    );
    if (existingKey.rows[0]) {
      if (existingKey.rows[0].request_hash !== input.requestHash) {
        throw new HttpError(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT");
      }
      const existingMessage = await client.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM messages WHERE id=$1 AND sender_user_id=$2",
        [existingKey.rows[0].resource_id, userId],
      );
      if (!existingMessage.rows[0]) throw new HttpError(409, "Idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      client.release();
      clientReleased = true;
      return getMessage(userId, existingMessage.rows[0].conversation_id, existingKey.rows[0].resource_id);
    }

    const draftResult = await client.query<{
      id: string; subject: string; body: string; to_addresses: string[]; cc_addresses: string[]; revision: number;
    }>(
      `SELECT id, subject, body, to_addresses, cc_addresses, revision
         FROM drafts
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [draftId, userId],
    );
    const draft = draftResult.rows[0];
    if (!draft) {
      const completed = await client.query<{ request_hash: string; resource_id: string }>(
        `SELECT request_hash, resource_id
           FROM idempotency_keys
          WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > now()
          FOR UPDATE`,
        [userId, input.idempotencyKey],
      );
      if (completed.rows[0]) {
        if (completed.rows[0].request_hash !== input.requestHash) {
          throw new HttpError(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT");
        }
        const existingMessage = await client.query<{ conversation_id: string }>(
          "SELECT conversation_id FROM messages WHERE id=$1 AND sender_user_id=$2",
          [completed.rows[0].resource_id, userId],
        );
        if (!existingMessage.rows[0]) throw new HttpError(409, "Idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT");
        client.release();
        clientReleased = true;
        return getMessage(userId, existingMessage.rows[0].conversation_id, completed.rows[0].resource_id);
      }
      throw new HttpError(404, "Draft not found", "NOT_FOUND");
    }
    if (draft.revision !== input.revision) {
      throw new HttpError(409, "Draft revision conflict", "REVISION_CONFLICT");
    }

    const members = conversationId
      ? await client.query<{ email: string; user_id: string | null }>(
        "SELECT email,user_id FROM conversation_members WHERE conversation_id = $1",
        [conversationId],
      )
      : { rows: [] as { email: string; user_id: string | null }[] };
    const memberIds = [...new Set(members.rows.map((member) => member.user_id).filter((id): id is string => Boolean(id) && id !== userId))];
    const currentMembers = memberIds.length
      ? await client.query<{ email: string }>(
        "SELECT email FROM addresses WHERE user_id=ANY($1::uuid[]) AND is_primary AND is_active",
        [memberIds],
      )
      : { rows: [] as { email: string }[] };
    const defaultTo = currentMembers.rows.map((row) => row.email).sort();
    const to = await normalizeRecipients(draft.to_addresses ?? [], client);
    const cc = await normalizeRecipients(draft.cc_addresses ?? [], client);
    if (to.length === 0) throw new HttpError(400, "Draft must have at least one recipient", "VALIDATION_ERROR");
    if (to.some((email) => myEmails.includes(email)) || cc.some((email) => myEmails.includes(email))) {
      throw new HttpError(400, "Draft recipients must not include the sender", "VALIDATION_ERROR");
    }
    const initialRecipients = conversationId ? await client.query<{ email: string; role: "to" | "cc"; recipient_user_id: string | null }>(
      `WITH first_message AS (
         SELECT id FROM messages WHERE conversation_id=$1 AND folder <> 'drafts'
          ORDER BY created_at ASC,id ASC LIMIT 1
       )
       SELECT DISTINCT ON (COALESCE(mr.recipient_user_id::text,cm.user_id::text,lower(mr.email)),mr.role)
              COALESCE(primary_address.email,mr.email) AS email,mr.role,
              COALESCE(mr.recipient_user_id,cm.user_id) AS recipient_user_id
         FROM message_recipients mr
         JOIN first_message fm ON fm.id=mr.message_id
         JOIN messages first_message_row ON first_message_row.id=mr.message_id
         LEFT JOIN conversation_members cm
           ON cm.conversation_id=first_message_row.conversation_id AND cm.email=mr.email
         LEFT JOIN addresses primary_address
           ON primary_address.user_id=COALESCE(mr.recipient_user_id,cm.user_id) AND primary_address.is_primary
        WHERE (COALESCE(mr.recipient_user_id,cm.user_id) IS NULL
            OR COALESCE(mr.recipient_user_id,cm.user_id) <> $2::uuid)
          AND lower(mr.email) <> lower($3::text)
        ORDER BY COALESCE(mr.recipient_user_id::text,cm.user_id::text,lower(mr.email)),mr.role`,
      [conversationId, userId, senderEmail],
    ) : { rows: [] as { email: string; role: "to" | "cc"; recipient_user_id: string | null }[] };
    const expectedTo = initialRecipients.rows.length
      ? initialRecipients.rows.filter((row) => row.role === "to").map((row) => row.email).sort()
      : defaultTo;
    const expectedCc = initialRecipients.rows.filter((row) => row.role === "cc").map((row) => row.email).sort();
    if (conversationId && (to.slice().sort().join("|") !== expectedTo.join("|") || cc.slice().sort().join("|") !== expectedCc.join("|"))) {
      throw new HttpError(400, "To and CC recipients are locked for an existing conversation", "RECIPIENTS_LOCKED");
    }
    const recipientUsers = await client.query<{ id: string; email: string }>(
      `SELECT DISTINCT a.user_id AS id,a.email FROM addresses a JOIN users u ON u.id=a.user_id
        WHERE a.email=ANY($1::text[]) AND a.is_active AND u.account_status='active'`,
      [[...to, ...cc]],
    );
    await lockChangeAccounts(client, [userId, ...recipientUsers.rows.map((recipient) => recipient.id)]);
    await assertNotBlocked(userId, recipientUsers.rows.map((recipient) => recipient.id), client);

    const uploads = attachmentIds.length === 0 ? { rows: [] as { filename: string; mime_type: string; size_bytes: number; storage_key: string; scanner_state: string }[] } : await client.query<{
      filename: string; mime_type: string; size_bytes: number; storage_key: string; scanner_state: string;
    }>(
      `SELECT filename, mime_type, size_bytes, storage_key, scanner_state
         FROM uploads
        WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = 'ready' AND expires_at > now()`,
      [attachmentIds, userId],
    );
    if (uploads.rows.length !== attachmentIds.length) {
      throw new HttpError(400, "All attachments must be owned, ready, and unexpired uploads", "ATTACHMENT_INVALID");
    }

    const recipientIdentityRows = await client.query<{ email: string; user_id: string | null; is_active: boolean; account_status: string | null }>(
      `SELECT a.email,a.user_id,a.is_active,u.account_status FROM addresses a LEFT JOIN users u ON u.id=a.user_id
        WHERE lower(a.email)=ANY($1::text[])`,
      [[...to, ...cc]],
    );
    const recipientIdentity = new Map(recipientIdentityRows.rows.map((row) => [row.email.toLowerCase(), {
      userId: row.user_id,
      active: row.is_active && row.account_status === "active",
    }]));
    for (const email of [...to, ...cc]) {
      const identity = recipientIdentity.get(email.toLowerCase());
      if (email.endsWith(`@${config.mailDomain}`) && (!identity?.userId || !identity.active)) {
        throw new HttpError(409, "Recipient address changed; resolve recipients again", "RECIPIENT_UNAVAILABLE");
      }
    }

    messageId = randomUUID();
    const insertedKey = await client.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, resource_type, resource_id, expires_at)
       VALUES ($1, $2, $3, 'message', $4, now() + interval '24 hours')
       ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
      [userId, input.idempotencyKey, input.requestHash, messageId],
    );
    if ((insertedKey.rowCount ?? 0) === 0) {
      const existing = await client.query<{ request_hash: string; resource_id: string }>(
        "SELECT request_hash, resource_id FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > now() FOR UPDATE",
        [userId, input.idempotencyKey],
      );
      if (!existing.rows[0] || existing.rows[0].request_hash !== input.requestHash) {
        throw new HttpError(409, "Idempotency key was already used with different content", "IDEMPOTENCY_CONFLICT");
      }
      await client.query("COMMIT");
      const existingMessage = await client.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM messages WHERE id=$1 AND sender_user_id=$2",
        [existing.rows[0].resource_id, userId],
      );
      if (!existingMessage.rows[0]) throw new HttpError(409, "Idempotency record is unavailable", "IDEMPOTENCY_CONFLICT");
      return getMessage(userId, existingMessage.rows[0].conversation_id, existing.rows[0].resource_id);
    }

    if (!conversationId) {
      const participants = [...new Set([senderEmail, ...to, ...cc])].sort((a, b) => a.localeCompare(b));
      if (participants.length === 2) {
        const pairKey = directPairKey(participants[0], participants[1]);
        const existing = await client.query<{ id: string }>(
          "SELECT id FROM conversations WHERE kind='direct' AND direct_pair_key=$1",
          [pairKey],
        );
        if (existing.rows[0]) {
          conversationId = existing.rows[0].id;
          const existingMembers = await client.query<{ email: string; user_id: string | null }>(
            "SELECT email,user_id FROM conversation_members WHERE conversation_id=$1 ORDER BY lower(email)",
            [conversationId],
          );
          if (existingMembers.rows.length && existingMembers.rows.map((member) => member.email.toLowerCase()).sort().join("|") !== participants.map((email) => email.toLowerCase()).sort().join("|")) {
            throw new HttpError(409, "Direct conversation identity changed; compose a new message", "RECIPIENTS_LOCKED");
          }
        } else {
          const created = await client.query<{ id: string }>(
            "INSERT INTO conversations(kind,direct_pair_key) VALUES('direct',$1) RETURNING id",
            [pairKey],
          );
          conversationId = created.rows[0].id;
        }
      } else {
        const created = await client.query<{ id: string }>(
          "INSERT INTO conversations(kind,direct_pair_key) VALUES('group',NULL) RETURNING id",
        );
        conversationId = created.rows[0].id;
      }
      const existingMembers = await client.query<{ email: string }>(
        "SELECT email FROM conversation_members WHERE conversation_id=$1",
        [conversationId],
      );
      if (!existingMembers.rows.length) {
        for (const email of participants) {
          const memberId = email.toLowerCase() === senderEmail.toLowerCase()
            ? userId
            : recipientIdentity.get(email.toLowerCase())?.userId ?? null;
          await client.query(
            "INSERT INTO conversation_members(conversation_id,email,user_id) VALUES($1,$2,$3) ON CONFLICT(conversation_id,email) DO NOTHING",
            [conversationId, email, memberId],
          );
        }
      }
    }

    if (!conversationId) throw new Error("Draft send did not resolve a conversation");
    const rfcMessageId = `<${messageId}@${config.mailDomain}>`;
    await client.query(
      `INSERT INTO messages (id, conversation_id, sender_email, sender_user_id, subject, body, folder, lifecycle_status,rfc_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'inbox', 'committed',$7)`,
      [messageId, conversationId, senderEmail, userId, draft.subject, draft.body, rfcMessageId],
    );
    for (const email of to) {
      await client.query("INSERT INTO message_recipients (message_id, email, role, recipient_user_id) VALUES ($1, $2, 'to', $3)", [messageId, email, recipientIdentity.get(email.toLowerCase())?.userId ?? null]);
    }
    for (const email of cc) {
      await client.query("INSERT INTO message_recipients (message_id, email, role, recipient_user_id) VALUES ($1, $2, 'cc', $3)", [messageId, email, recipientIdentity.get(email.toLowerCase())?.userId ?? null]);
    }
    for (const upload of uploads.rows) {
      await client.query(
        "INSERT INTO attachments (message_id, filename, mime_type, size_bytes, storage_key, scanner_state) VALUES ($1, $2, $3, $4, $5, $6)",
        [messageId, upload.filename, upload.mime_type, upload.size_bytes, upload.storage_key, upload.scanner_state],
      );
    }
    await client.query(
      `INSERT INTO user_message_state (user_id, message_id, is_read, is_favorite, folder)
       VALUES ($1, $2, TRUE, FALSE, 'sent')`,
      [userId, messageId],
    );
    for (const recipient of recipientUsers.rows) {
      await client.query(
        `INSERT INTO user_message_state (user_id, message_id, is_read, is_favorite, folder)
         VALUES ($1, $2, FALSE, FALSE, 'inbox') ON CONFLICT (user_id, message_id) DO NOTHING`,
        [recipient.id, messageId],
      );
      await client.query(
        "INSERT INTO message_deliveries(message_id,recipient_user_id,status) VALUES($1,$2,'local_committed')",
        [messageId, recipient.id],
      );
    }
    const externalAddresses = [...new Set([...to, ...cc].filter((email) => !email.endsWith(`@${config.mailDomain}`)))];
    const externalRoles = new Map<string, "to" | "cc">(to.map((email) => [email, "to"]));
    for (const email of cc) if (!externalRoles.has(email)) externalRoles.set(email, "cc");
    for (const email of externalAddresses) {
      await client.query(
        "INSERT INTO smtp_message_deliveries(message_id,recipient_email,role,status) VALUES($1,$2,$3,'queued')",
        [messageId, email, externalRoles.get(email)],
      );
    }
    await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    await recordChange(client, userId, "message", messageId, "created", { conversationId });
    for (const recipient of recipientUsers.rows) {
      await recordChange(client, recipient.id, "message", messageId, "created", { conversationId });
    }
    if (recipientUsers.rows.length) {
      await client.query(
        "INSERT INTO outbox_jobs (kind, payload) VALUES ('message.notification', $1::jsonb)",
        [JSON.stringify({ messageId, conversationId, senderUserId: userId })],
      );
    }
    if (externalAddresses.length) {
      await client.query(
        "INSERT INTO outbox_jobs (kind,payload) VALUES ('message.smtp-delivery',$1::jsonb)",
        [JSON.stringify({ messageId })],
      );
    }
    await client.query("DELETE FROM drafts WHERE id = $1 AND user_id = $2 AND revision = $3", [draftId, userId, input.revision]);
    await client.query("COMMIT");
  } catch (err) {
    if (!clientReleased) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (!clientReleased) client.release();
  }
  if (!conversationId) throw new Error("Draft send completed without a conversation");
  return getMessage(userId, conversationId, messageId);
}

export async function getOperationResult(userId: string, idempotencyKey: string) {
  const result = await query<{ resource_type: string; resource_id: string }>(
    `SELECT resource_type, resource_id
       FROM idempotency_keys
      WHERE user_id = $1 AND idempotency_key = $2 AND expires_at > now()`,
    [userId, idempotencyKey],
  );
  if (result.rowCount === 0) {
    throw new HttpError(404, "Operation result was not found or has expired", "NOT_FOUND");
  }
  return { resourceType: result.rows[0].resource_type, resourceId: result.rows[0].resource_id };
}

async function getMessage(userId: string, conversationId: string, messageId: string): Promise<MessageDetail> {
  await assertMember(userId, conversationId);
  if (!UUID_PATTERN.test(messageId)) throw new HttpError(400, "message id must be a UUID");
  const result = await query<{
    id: string; conversation_id: string; sender_email: string; subject: string; body: string;
    content_format: "plain" | "openpgp-v1";
    in_reply_to_id: string | null; viewer_folder: "inbox" | "drafts" | "spam" | "trash"; created_at: Date;
    is_read: boolean; is_favorite: boolean; lifecycle_status: "draft" | "committed" | "failed";
  }>(
    `SELECT m.id, m.conversation_id, m.sender_email, m.subject, m.body,m.content_format,m.in_reply_to_id,m.lifecycle_status,
            COALESCE(ums.folder, m.folder) AS viewer_folder, m.created_at,
            COALESCE(ums.is_read, FALSE) AS is_read, COALESCE(ums.is_favorite, FALSE) AS is_favorite
     FROM messages m
     LEFT JOIN user_message_state ums ON ums.message_id = m.id AND ums.user_id = $1
     WHERE m.id = $2 AND m.conversation_id = $3
       AND (m.sender_user_id = $1 OR (m.folder <> 'drafts' AND COALESCE(ums.folder, m.folder) <> 'drafts'))`,
    [userId, messageId, conversationId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, "Message not found");
  const recipients = await query<{ email: string; role: "to" | "cc" }>(
    "SELECT email, role FROM message_recipients WHERE message_id = $1 ORDER BY id", [messageId]
  );
  const attachments = await query<{ id: string; filename: string; mime_type: string; size_bytes: number; storage_key: string; scanner_state: string }>(
    `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.storage_key, a.scanner_state
       FROM attachments a
      WHERE a.message_id = $1
        AND (EXISTS (SELECT 1 FROM messages m WHERE m.id = a.message_id AND m.sender_user_id = $2)
             OR EXISTS (
               SELECT 1 FROM message_recipients mr
               JOIN messages m ON m.id = mr.message_id
                WHERE mr.message_id = a.message_id AND mr.recipient_user_id = $2
                  AND m.folder <> 'drafts'
             ))`, [messageId, userId]
  );
  return {
    id: row.id, conversationId: row.conversation_id, senderEmail: row.sender_email,
    subject: row.subject, body: row.body, inReplyToId: row.in_reply_to_id, folder: row.viewer_folder,
    lifecycleStatus: row.lifecycle_status,
    contentFormat: row.content_format,
    createdAt: row.created_at.toISOString(), recipients: recipients.rows,
    attachments: attachments.rows.map((item) => ({ id: item.id, filename: item.filename, mimeType: item.mime_type, sizeBytes: item.size_bytes, storageKey: item.storage_key, scanStatus: item.scanner_state })),
    isRead: row.is_read, isFavorite: row.is_favorite,
  };
}

export async function getFullMessage(userId: string, conversationId: string, messageId: string): Promise<MessageDetail> {
  return getMessage(userId, conversationId, messageId);
}

export async function getMessageDeliveryStatus(userId: string, conversationId: string, messageId: string) {
  await assertMember(userId, conversationId);
  const result = await query<{ lifecycle_status: string }>(
    "SELECT lifecycle_status FROM messages WHERE id=$1 AND conversation_id=$2 AND sender_user_id=$3",
    [messageId, conversationId, userId],
  );
  if (!result.rows[0]) throw new HttpError(404, "Message status not found", "NOT_FOUND");
  const deliveries = await query<{
    email: string; role: "to" | "cc"; status: string; is_read: boolean | null;
  }>(
    `SELECT mr.email,mr.role,md.status,
            CASE WHEN COALESCE(np.read_receipts,TRUE) THEN ums.is_read ELSE NULL END AS is_read
       FROM message_recipients mr
       JOIN message_deliveries md ON md.message_id=mr.message_id AND md.recipient_user_id=mr.recipient_user_id
       LEFT JOIN notification_preferences np ON np.user_id=mr.recipient_user_id
       LEFT JOIN user_message_state ums ON ums.message_id=mr.message_id AND ums.user_id=mr.recipient_user_id
      WHERE mr.message_id=$1 ORDER BY mr.role,mr.email`,
    [messageId],
  );
  const smtpDeliveries = await query<{ email: string; role: "to" | "cc"; status: string; is_read: null }>(
    `SELECT recipient_email AS email,role,status,NULL::boolean AS is_read
       FROM smtp_message_deliveries WHERE message_id=$1 ORDER BY role,recipient_email`,
    [messageId],
  );
  return {
    lifecycleStatus: result.rows[0].lifecycle_status,
    recipients: [...deliveries.rows, ...smtpDeliveries.rows],
  };
}

async function normalizeRecipients(values: string[], db = { query } as { query: typeof query }): Promise<string[]> {
  const normalized = await Promise.all(values.map(async (value) => {
    const trimmed = String(value).trim();
    if (trimmed.includes("@")) {
      const email = normalizeEmailAddress(trimmed);
      if (email.slice(email.lastIndexOf("@") + 1) !== config.mailDomain) return email;
      const result = await db.query<{ email: string }>(
        `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
          WHERE lower(a.email)=lower($1) AND a.is_active AND u.account_status='active'`,
        [email],
      );
      if (!result.rows[0]) throw new HttpError(404, "PhoneMail recipient address is not registered");
      return result.rows[0].email;
    }
    const normalizedPhone = trimmed.startsWith("+") || trimmed.startsWith("00")
      ? normalizePhone(trimmed)
      : phoneNumberFromPublicIdentity(trimmed);
    const email = emailFromPhone(normalizedPhone, config.mailDomain);
    const result = await db.query<{ email: string }>(
      `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
        WHERE a.email=$1 AND a.is_active AND u.account_status='active'`,
      [email],
    );
    if (!result.rows[0]) {
      if (!trimmed.startsWith("+") && !trimmed.startsWith("00") && !config.phoneDefaultCountry) {
        throw new HttpError(400, "Use an international recipient number or provide a configured country", "PHONE_COUNTRY_REQUIRED");
      }
      if (config.phoneDefaultCountry && !trimmed.startsWith("+") && !trimmed.startsWith("00")) {
        const countryNormalized = emailFromPhone(normalizePhone(trimmed, config.phoneDefaultCountry), config.mailDomain);
        const countryResult = await db.query<{ email: string }>(
          `SELECT a.email FROM addresses a JOIN users u ON u.id=a.user_id
            WHERE a.email=$1 AND a.is_active AND u.account_status='active'`,
          [countryNormalized],
        );
        if (countryResult.rows[0]) return countryResult.rows[0].email;
      }
      throw new HttpError(404, "Recipient phone is not registered");
    }
    return result.rows[0].email;
  }));
  return [...new Set(normalized)];
}
