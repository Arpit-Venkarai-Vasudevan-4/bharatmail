import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware";
import { asyncHandler, HttpError } from "../httpError";
import {
  createConversation,
  getConversation,
  listConversations,
  sendMessage,
  updateMessageState,
  listMailbox,
  getOperationResult,
  getFullMessage,
  getMessageDeliveryStatus,
  type ConversationFilter,
} from "../services/conversationService";

export const conversationsRouter = Router();

const filters = new Set<ConversationFilter>(["all", "unread", "attachments", "favorites"]);

conversationsRouter.get("/operations/:key", asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  if (!/^[\x20-\x7e]{8,128}$/.test(req.params.key)) {
    throw new HttpError(400, "Invalid operation key", "VALIDATION_ERROR");
  }
  res.json({ operation: await getOperationResult(userId, req.params.key) });
}));

conversationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const raw = typeof req.query.filter === "string" ? req.query.filter : "all";
    if (!filters.has(raw as ConversationFilter)) {
      throw new HttpError(400, "filter must be all, unread, attachments, or favorites");
    }
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = Number(req.query.limit ?? 50);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(await listConversations(userId, raw as ConversationFilter, q, undefined, limit, cursor));
  })
);

conversationsRouter.patch("/:id/messages/:messageId/state", asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { isRead, isFavorite, folder } = req.body ?? {};
  if (isRead !== undefined && typeof isRead !== "boolean" ||
      isFavorite !== undefined && typeof isFavorite !== "boolean" ||
      folder !== undefined && typeof folder !== "string") {
    throw new HttpError(400, "Invalid message state");
  }
  await updateMessageState(userId, req.params.id, req.params.messageId, { isRead, isFavorite, folder });
  res.status(204).send();
}));

conversationsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const phones = req.body?.participantPhones;
    if (!Array.isArray(phones) || phones.length === 0 || phones.length > 50 || phones.some((value: unknown) => typeof value !== "string" || value.trim().length === 0)) {
      throw new HttpError(400, "participantPhones must be a non-empty array");
    }
    const country = req.body?.country;
    if (country !== undefined && (typeof country !== "string" || country.length !== 2)) {
      throw new HttpError(400, "country must be a two-letter region code", "VALIDATION_ERROR");
    }
    const conversation = await createConversation(userId, phones.map(String), country);
    res.status(201).json({ conversation });
  })
);

conversationsRouter.get("/mailbox/:folder", asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  const folder = req.params.folder;
  if (!["inbox", "sent", "drafts", "trash", "archive", "spam"].includes(folder)) {
    throw new HttpError(400, "folder must be inbox, sent, drafts, trash, archive, or spam");
  }
  const limit = Number(req.query.limit ?? 20);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  res.json(await listMailbox(userId, folder as "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam", limit, cursor));
}));

conversationsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    if (!Number.isInteger(page) || !Number.isInteger(pageSize) || page < 1 || pageSize < 1 || pageSize > 100) {
      throw new HttpError(400, "page must be a positive integer and pageSize must be 1 to 100");
    }
    const detail = await getConversation(userId, req.params.id, page, pageSize);
    res.json(detail);
  })
);

conversationsRouter.get("/:id/messages", asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 20);
  if (!Number.isInteger(page) || !Number.isInteger(pageSize) || page < 1 || pageSize < 1 || pageSize > 100) {
    throw new HttpError(400, "page must be a positive integer and pageSize must be 1 to 100");
  }
  const detail = await getConversation(userId, req.params.id, page, pageSize);
  res.json({ messages: detail.messages, pagination: detail.pagination });
}));

conversationsRouter.get("/:id/messages/:messageId", asyncHandler(async (req, res) => {
  const message = await getFullMessage((req as AuthedRequest).userId, req.params.id, req.params.messageId);
  res.json({ message });
}));
conversationsRouter.get("/:id/messages/:messageId/delivery", asyncHandler(async (req, res) => {
  const status = await getMessageDeliveryStatus((req as AuthedRequest).userId, req.params.id, req.params.messageId);
  res.json({ delivery: status });
}));

conversationsRouter.post(
  "/:id/messages",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const allowedFields = new Set(["subject", "body", "to", "cc", "inReplyToId", "folder"]);
    if (Object.keys(req.body ?? {}).some((key) => !allowedFields.has(key))) {
      throw new HttpError(400, "Unsupported message fields; BCC is not supported", "VALIDATION_ERROR");
    }
    const { subject, body, to, cc, inReplyToId, folder } = req.body ?? {};
    if (typeof body !== "string" || body.trim().length === 0 || body.length > 100000) {
      throw new HttpError(400, "body is required");
    }
    if (subject !== undefined && (typeof subject !== "string" || subject.length > 200)) {
      throw new HttpError(400, "subject must be at most 200 characters");
    }
    for (const recipients of [to, cc]) {
      if (recipients !== undefined &&
          (!Array.isArray(recipients) || recipients.length > 50 || recipients.some((recipient) => typeof recipient !== "string"))) {
        throw new HttpError(400, "to and cc must be arrays of at most 50 addresses", "VALIDATION_ERROR");
      }
    }
    const idempotencyKey = req.header("Idempotency-Key");
    if (idempotencyKey && !/^[\x20-\x7e]{8,128}$/.test(idempotencyKey)) {
      throw new HttpError(400, "Idempotency-Key must be 8 to 128 printable characters");
    }
    const message = await sendMessage(userId, req.params.id, {
      subject,
      body,
      to,
      cc,
      inReplyToId,
      folder,
      idempotencyKey,
      requestHash: JSON.stringify({ operation: "message.send", conversationId: req.params.id, subject, body, to, cc, inReplyToId, folder }),
    });

    res.status(201).json({ message });
  })
);
