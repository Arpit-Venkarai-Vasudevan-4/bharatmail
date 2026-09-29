import { Router } from "express";
import type { AuthedRequest } from "../auth/middleware";
import { authRateLimit } from "../auth/rateLimit";
import { asyncHandler, HttpError } from "../httpError";
import {
  commitKeyOperation,
  createKeyChallenge,
  getEncryptedDraft,
  getEncryptedMessage,
  listCurrentKeys,
  listPublicKeyHistory,
  listEncryptedDrafts,
  deleteEncryptedDraft,
  reauthenticateE2ee,
  saveEncryptedDraft,
  sendEncryptedDraft,
  sendEncryptedMessage,
} from "../services/e2eeService";
import { UUID_PATTERN } from "../services/conversationService";

export const e2eeRouter = Router();

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "A JSON object is required", "VALIDATION_ERROR");
  }
  return body as Record<string, unknown>;
}

function rejectUnexpected(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, "Unsupported E2EE request field", "VALIDATION_ERROR");
  }
}

function stringField(body: Record<string, unknown>, name: string, max: number): string {
  const value = body[name];
  if (typeof value !== "string" || !value || value.length > max) {
    throw new HttpError(400, `${name} must be a non-empty string of at most ${max} characters`, "VALIDATION_ERROR");
  }
  return value;
}

function stringArray(body: Record<string, unknown>, name: string, max: number, required = false): string[] {
  const value = body[name];
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item)) {
    throw new HttpError(400, `${name} must be an array of at most ${max} strings`, "VALIDATION_ERROR");
  }
  return value as string[];
}

function idempotencyKey(req: import("express").Request) {
  const value = req.header("Idempotency-Key");
  if (!value || !/^[\x20-\x7e]{8,128}$/.test(value)) {
    throw new HttpError(400, "A valid Idempotency-Key header is required", "VALIDATION_ERROR");
  }
  return value;
}

e2eeRouter.post("/reauth", authRateLimit, asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["password"]);
  const auth = req as AuthedRequest;
  await reauthenticateE2ee(auth.userId, auth.sessionId, stringField(body, "password", 1024));
  res.status(204).send();
}));

e2eeRouter.post("/key-challenges", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["action"]);
  if (!["enroll", "rotate", "revoke"].includes(String(body.action))) {
    throw new HttpError(400, "action must be enroll, rotate, or revoke", "VALIDATION_ERROR");
  }
  const auth = req as AuthedRequest;
  res.status(201).json({
    challenge: await createKeyChallenge(auth.userId, auth.sessionId, body.action as "enroll" | "rotate" | "revoke"),
  });
}));

e2eeRouter.post("/keys", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["action", "challengeId", "publicKey", "proof", "previousProof"]);
  const action = body.action;
  if (!["enroll", "rotate", "revoke"].includes(String(action))) {
    throw new HttpError(400, "action must be enroll, rotate, or revoke", "VALIDATION_ERROR");
  }
  const auth = req as AuthedRequest;
  const result = await commitKeyOperation({
    userId: auth.userId,
    sessionId: auth.sessionId,
    action: action as "enroll" | "rotate" | "revoke",
    challengeId: stringField(body, "challengeId", 36),
    ...(body.publicKey === undefined ? {} : { publicKey: stringField(body, "publicKey", 32 * 1024) }),
    proof: stringField(body, "proof", 32 * 1024),
    ...(body.previousProof === undefined ? {} : { previousProof: stringField(body, "previousProof", 32 * 1024) }),
  });
  res.status(201).json({ key: result });
}));

e2eeRouter.get("/keys", asyncHandler(async (req, res) => {
  const raw = req.query.userIds;
  if (typeof raw !== "string") throw new HttpError(400, "userIds query parameter is required", "VALIDATION_ERROR");
  const userIds = raw.split(",");
  res.json({ keys: await listCurrentKeys(userIds) });
}));

e2eeRouter.get("/keys/:userId", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.userId)) throw new HttpError(400, "userId must be a UUID", "VALIDATION_ERROR");
  const keys = await listCurrentKeys([req.params.userId]);
  if (!keys.length) throw new HttpError(404, "No active encryption key found", "NOT_FOUND");
  res.json({ key: keys[0] });
}));

e2eeRouter.get("/keys/:userId/history", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.userId)) throw new HttpError(400, "userId must be a UUID", "VALIDATION_ERROR");
  res.json({ keys: await listPublicKeyHistory(req.params.userId) });
}));

e2eeRouter.delete("/keys/current", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["challengeId", "proof"]);
  const auth = req as AuthedRequest;
  const result = await commitKeyOperation({
    userId: auth.userId,
    sessionId: auth.sessionId,
    action: "revoke",
    challengeId: stringField(body, "challengeId", 36),
    proof: stringField(body, "proof", 32 * 1024),
  });
  res.json({ key: result });
}));

e2eeRouter.post("/messages", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["to", "cc", "ciphertext", "keyFingerprints", "replyToId"]);
  const auth = req as AuthedRequest;
  const to = stringArray(body, "to", 50, true);
  const cc = stringArray(body, "cc", 50);
  const keyFingerprints = stringArray(body, "keyFingerprints", 51, true);
  if (body.replyToId !== undefined && (typeof body.replyToId !== "string" || !UUID_PATTERN.test(body.replyToId))) {
    throw new HttpError(400, "replyToId must be a message UUID", "VALIDATION_ERROR");
  }
  const ciphertext = stringField(body, "ciphertext", 14 * 1024 * 1024);
  const key = idempotencyKey(req);
  const requestHash = JSON.stringify({ operation: "e2ee.message", to, cc, ciphertext, keyFingerprints, replyToId: body.replyToId ?? null });
  const message = await sendEncryptedMessage({
    userId: auth.userId, to, cc, ciphertext, keyFingerprints, idempotencyKey: key, requestHash,
    ...(typeof body.replyToId === "string" ? { replyToId: body.replyToId } : {}),
  });
  res.status(message.duplicate ? 200 : 201).json({ message, contentFormat: "openpgp-v1" });
}));

e2eeRouter.get("/messages/:id", asyncHandler(async (req, res) => {
  res.json({ message: await getEncryptedMessage((req as AuthedRequest).userId, req.params.id) });
}));

e2eeRouter.get("/drafts", asyncHandler(async (req, res) => {
  res.json({ drafts: await listEncryptedDrafts((req as AuthedRequest).userId) });
}));

e2eeRouter.post("/drafts", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["ciphertext"]);
  const draft = await saveEncryptedDraft({
    userId: (req as AuthedRequest).userId,
    ciphertext: stringField(body, "ciphertext", 14 * 1024 * 1024),
  });
  res.status(201).json({ draft });
}));

e2eeRouter.get("/drafts/:id", asyncHandler(async (req, res) => {
  res.json({ draft: await getEncryptedDraft((req as AuthedRequest).userId, req.params.id) });
}));

e2eeRouter.delete("/drafts/:id", asyncHandler(async (req, res) => {
  await deleteEncryptedDraft((req as AuthedRequest).userId, req.params.id);
  res.status(204).send();
}));

e2eeRouter.put("/drafts/:id", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["ciphertext", "revision"]);
  if (!Number.isInteger(body.revision) || Number(body.revision) < 1) {
    throw new HttpError(400, "revision must be a positive integer", "VALIDATION_ERROR");
  }
  const draft = await saveEncryptedDraft({
    userId: (req as AuthedRequest).userId,
    id: req.params.id,
    revision: Number(body.revision),
    ciphertext: stringField(body, "ciphertext", 14 * 1024 * 1024),
  });
  res.setHeader("ETag", `"revision-${draft.revision}"`);
  res.json({ draft });
}));

e2eeRouter.post("/drafts/:id/send", asyncHandler(async (req, res) => {
  const body = objectBody(req.body);
  rejectUnexpected(body, ["revision", "to", "cc", "keyFingerprints", "ciphertext"]);
  if (!Number.isInteger(body.revision) || Number(body.revision) < 1) {
    throw new HttpError(400, "revision must be a positive integer", "VALIDATION_ERROR");
  }
  const auth = req as AuthedRequest;
  const to = stringArray(body, "to", 50, true);
  const cc = stringArray(body, "cc", 50);
  const keyFingerprints = stringArray(body, "keyFingerprints", 51, true);
  const ciphertext = stringField(body, "ciphertext", 14 * 1024 * 1024);
  const key = idempotencyKey(req);
  const requestHash = JSON.stringify({ operation: "e2ee.draft.send", draftId: req.params.id, revision: body.revision, to, cc, keyFingerprints, ciphertext });
  const message = await sendEncryptedDraft({
    userId: auth.userId,
    id: req.params.id,
    revision: Number(body.revision),
    ciphertext,
    to,
    cc,
    keyFingerprints,
    idempotencyKey: key,
    requestHash,
  });
  res.status(message.duplicate ? 200 : 201).json({ message, contentFormat: "openpgp-v1" });
}));
