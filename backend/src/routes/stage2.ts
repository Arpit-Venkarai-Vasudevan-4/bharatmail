import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware";
import { asyncHandler, HttpError } from "../httpError";
import { closeSyncSnapshot, createSyncSnapshot, deleteDraft, getDraft, listDrafts, saveDraft, syncChanges } from "../services/stage2Service";
import { searchMessages, sendDraft } from "../services/conversationService";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { config } from "../config";
import { query } from "../db";

export const stage2Router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

stage2Router.get("/drafts", asyncHandler(async (req, res) => {
  res.json({ drafts: await listDrafts((req as AuthedRequest).userId) });
}));
stage2Router.get("/users/:id/profile-picture", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "user id must be a UUID", "VALIDATION_ERROR");
  const viewerId = (req as AuthedRequest).userId;
  const picture = await query<{ storage_key: string; mime_type: string }>(
    `SELECT u.storage_key,u.mime_type
       FROM users profile
       JOIN uploads u ON u.id=profile.profile_picture_upload_id AND u.user_id=profile.id
      WHERE profile.id=$1 AND profile.account_status='active'
        AND (profile.id=$2 OR COALESCE((SELECT profile_visible FROM notification_preferences WHERE user_id=profile.id),TRUE))
        AND u.status='ready' AND u.mime_type IN ('image/png','image/jpeg','image/gif')`,
    [req.params.id, viewerId],
  );
  if (!picture.rows[0]) throw new HttpError(404, "Profile picture not found", "NOT_FOUND");
  res.setHeader("Content-Type", picture.rows[0].mime_type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  createReadStream(join(config.storageDir, picture.rows[0].storage_key)).pipe(res);
}));
stage2Router.get("/search/messages", asyncHandler(async (req, res) => {
  if (typeof req.query.q !== "string") throw new HttpError(400, "q is required", "VALIDATION_ERROR");
  const limit = Number(req.query.limit ?? 25);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  res.json(await searchMessages((req as AuthedRequest).userId, req.query.q, limit, cursor));
}));
stage2Router.post("/drafts", asyncHandler(async (req, res) => {
  const allowedFields = new Set(["subject", "body", "to", "cc"]);
  if (Object.keys(req.body ?? {}).some((key) => !allowedFields.has(key))) {
    throw new HttpError(400, "Unsupported draft fields; BCC is not supported", "VALIDATION_ERROR");
  }
  res.status(201).json({ draft: await saveDraft((req as AuthedRequest).userId, undefined, req.body ?? {}) });
}));
stage2Router.get("/drafts/:id", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "draft id must be a UUID", "VALIDATION_ERROR");
  res.json({ draft: await getDraft((req as AuthedRequest).userId, req.params.id) });
}));
stage2Router.patch("/drafts/:id", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "draft id must be a UUID", "VALIDATION_ERROR");
  const allowedFields = new Set(["subject", "body", "to", "cc"]);
  if (Object.keys(req.body ?? {}).some((key) => !allowedFields.has(key))) {
    throw new HttpError(400, "Unsupported draft fields; BCC is not supported", "VALIDATION_ERROR");
  }
  const match = req.header("If-Match");
  const revision = match ? Number(match.replace(/^"revision-/, "").replace(/"$/, "")) : undefined;
  if (revision !== undefined && !Number.isInteger(revision)) throw new HttpError(400, "If-Match must contain a draft revision", "VALIDATION_ERROR");
  const result = await saveDraft((req as AuthedRequest).userId, req.params.id, req.body ?? {}, revision);
  res.setHeader("ETag", `"revision-${result.revision}"`);
  res.json({ draft: result });
}));
stage2Router.post("/drafts/:id/send", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "draft id must be a UUID", "VALIDATION_ERROR");
  const match = req.header("If-Match");
  if (!match) throw new HttpError(428, "If-Match is required when sending a draft", "PRECONDITION_REQUIRED");
  const revision = Number(match.replace(/^"revision-/, "").replace(/"$/, ""));
  if (!Number.isInteger(revision) || revision < 1) throw new HttpError(400, "If-Match must contain a draft revision", "VALIDATION_ERROR");
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || !/^[\x20-\x7e]{8,128}$/.test(idempotencyKey)) {
    throw new HttpError(400, "Idempotency-Key must be 8 to 128 printable characters", "VALIDATION_ERROR");
  }
  const { conversationId, attachmentIds } = req.body ?? {};
  if (Object.keys(req.body ?? {}).some((key) => !["conversationId", "attachmentIds"].includes(key))) {
    throw new HttpError(400, "Unsupported draft-send fields; BCC is not supported", "VALIDATION_ERROR");
  }
  if (conversationId !== undefined && typeof conversationId !== "string") {
    throw new HttpError(400, "conversationId must be a string when provided", "VALIDATION_ERROR");
  }
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 50 || attachmentIds.some((id: unknown) => typeof id !== "string"))) {
    throw new HttpError(400, "attachmentIds must be an array of upload ids", "VALIDATION_ERROR");
  }
  const result = await sendDraft((req as AuthedRequest).userId, req.params.id, {
    ...(conversationId ? { conversationId } : {}),
    revision,
    attachmentIds: attachmentIds ?? [],
    idempotencyKey,
    requestHash: JSON.stringify({ operation: "draft.send", draftId: req.params.id, conversationId: conversationId ?? null, revision, attachmentIds: attachmentIds ?? [] }),
  });
  res.status(201).json({ message: result });
}));
stage2Router.delete("/drafts/:id", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "draft id must be a UUID", "VALIDATION_ERROR");
  const revision = req.query.revision === undefined ? undefined : Number(req.query.revision);
  await deleteDraft((req as AuthedRequest).userId, req.params.id, revision);
  res.status(204).send();
}));
stage2Router.get("/sync", asyncHandler(async (req, res) => {
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  const limit = Number(req.query.limit ?? 50);
  res.json(await syncChanges((req as AuthedRequest).userId, cursor, limit));
}));
stage2Router.get("/sync/snapshot", asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit ?? 50);
  const snapshotId = typeof req.query.snapshotId === "string" ? req.query.snapshotId : undefined;
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  if ((snapshotId && !UUID_PATTERN.test(snapshotId)) || (!snapshotId && cursor !== undefined)) {
    throw new HttpError(400, "snapshotId must be a UUID and cursor requires snapshotId", "INVALID_CURSOR");
  }
  res.json(await createSyncSnapshot((req as AuthedRequest).userId, limit, snapshotId, cursor));
}));
stage2Router.post("/sync/snapshot/:id/close", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "snapshot id must be a UUID", "INVALID_CURSOR");
  await closeSyncSnapshot((req as AuthedRequest).userId, req.params.id);
  res.status(204).send();
}));
