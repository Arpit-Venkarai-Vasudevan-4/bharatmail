import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware";
import { asyncHandler, HttpError } from "../httpError";
import { getFullMessage } from "../services/conversationService";
import { composeMail, replyToIncomingMail } from "../services/smtpService";

export const mailRouter = Router();

function recipientList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50 || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `${name} must be an array of at most 50 email addresses`, "VALIDATION_ERROR");
  }
  return value;
}

function messageText(body: unknown, subject: unknown) {
  if (typeof body !== "string" || !body.trim() || body.length > 100_000) {
    throw new HttpError(400, "body is required and must be at most 100000 characters", "VALIDATION_ERROR");
  }
  if (subject !== undefined && (typeof subject !== "string" || subject.length > 200 || /[\r\n\0]/.test(subject))) {
    throw new HttpError(400, "subject must be at most 200 characters without header breaks", "VALIDATION_ERROR");
  }
}

function keyFromRequest(req: Parameters<Parameters<typeof asyncHandler>[0]>[0]): string {
  const key = req.header("Idempotency-Key");
  if (!key || !/^[\x20-\x7e]{8,128}$/.test(key)) {
    throw new HttpError(400, "A valid Idempotency-Key header is required", "VALIDATION_ERROR");
  }
  return key;
}

mailRouter.post("/compose", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const allowed = new Set(["to", "cc", "subject", "body", "attachmentIds"]);
  if (Object.keys(req.body ?? {}).some((field) => !allowed.has(field))) {
    throw new HttpError(400, "Unsupported compose field", "VALIDATION_ERROR");
  }
  const to = recipientList(req.body?.to, "to");
  const cc = recipientList(req.body?.cc, "cc");
  messageText(req.body?.body, req.body?.subject);
  const attachmentIds = req.body?.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some((id: unknown) => typeof id !== "string")) {
    throw new HttpError(400, "attachmentIds must contain at most 10 upload IDs", "VALIDATION_ERROR");
  }
  const idempotencyKey = keyFromRequest(req);
  const requestHash = JSON.stringify({ operation: "mail.compose", to, cc, subject: req.body?.subject, body: req.body?.body, attachmentIds });
  const result = await composeMail(userId, { to, cc, subject: req.body?.subject, body: req.body.body, attachmentIds, idempotencyKey, requestHash });
  res.status(201).json({
    message: await getFullMessage(userId, result.conversationId, result.messageId),
    delivery: { status: result.delivery },
  });
}));

mailRouter.post("/reply", asyncHandler(async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const allowed = new Set(["conversationId", "messageId", "subject", "body", "attachmentIds"]);
  if (Object.keys(req.body ?? {}).some((field) => !allowed.has(field))) {
    throw new HttpError(400, "Unsupported reply field", "VALIDATION_ERROR");
  }
  const { conversationId, messageId } = req.body ?? {};
  if (typeof conversationId !== "string" || typeof messageId !== "string") {
    throw new HttpError(400, "conversationId and messageId are required", "VALIDATION_ERROR");
  }
  messageText(req.body?.body, req.body?.subject);
  const attachmentIds = req.body?.attachmentIds ?? [];
  if (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some((id: unknown) => typeof id !== "string")) {
    throw new HttpError(400, "attachmentIds must contain at most 10 upload IDs", "VALIDATION_ERROR");
  }
  const idempotencyKey = keyFromRequest(req);
  const requestHash = JSON.stringify({ operation: "mail.reply", conversationId, messageId, subject: req.body?.subject, body: req.body?.body, attachmentIds });
  const result = await replyToIncomingMail(userId, conversationId, messageId, {
    subject: req.body?.subject,
    body: req.body.body,
    attachmentIds,
    idempotencyKey,
    requestHash,
  });
  res.status(201).json({
    message: await getFullMessage(userId, result.conversationId, result.messageId),
    delivery: { status: result.delivery },
  });
}));
