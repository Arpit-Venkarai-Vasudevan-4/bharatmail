import { Router } from "express";
import { asyncHandler, HttpError } from "../httpError";
import { pool, query } from "../db";
import { addAlias, deleteAlias, listAddresses, setAliasActive } from "../services/addressService";
import { getUserById, updateProfilePicture, updateUser } from "../services/userService";
import type { AuthedRequest } from "../auth/middleware";
import { confirmRecipient, deleteContact, listContacts, saveContact, setBlock } from "../services/contactService";
import { lockChangeAccounts, recordChange } from "../services/stage2Service";
import { UUID_PATTERN } from "../services/conversationService";
import { listSecurityNotifications, markSecurityNotificationRead, recordSecurityEvent } from "../services/securityEventService";

export const meRouter = Router();

meRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const user = await getUserById(userId);
    const addresses = await listAddresses(userId);
    res.json({ user, addresses });
  })
);

meRouter.get("/security-events", asyncHandler(async (req, res) => {
  const limit = Number(req.query.limit ?? 25);
  res.json({ events: await listSecurityNotifications((req as AuthedRequest).userId, limit) });
}));

meRouter.patch("/security-events/:id/read", asyncHandler(async (req, res) => {
  const updated = await markSecurityNotificationRead((req as AuthedRequest).userId, req.params.id);
  if (!updated) throw new HttpError(404, "Security event not found", "NOT_FOUND");
  res.status(204).send();
}));

meRouter.patch("/", asyncHandler(async (req, res) => {
  const { userId } = req as AuthedRequest;
  const { displayName, language } = req.body ?? {};
  if (Object.keys(req.body ?? {}).some((key) => !["displayName", "language"].includes(key)) ||
      (displayName === undefined && language === undefined)) {
    throw new HttpError(400, "Only displayName and language may be updated here", "VALIDATION_ERROR");
  }
  res.json({ user: await updateUser(userId, { displayName, language }) });
}));

async function updateMobileAppPresence(userId: string, present: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [userId]);
    const result = await client.query(
      "UPDATE users SET has_mobile_app=$2,updated_at=now() WHERE id=$1 RETURNING id",
      [userId, present],
    );
    if (!result.rowCount) throw new HttpError(404, "User not found", "NOT_FOUND");
    await recordChange(client, userId, "account", userId, "upserted", { hasMobileApp: present });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

meRouter.post("/app-presence", asyncHandler(async (req, res) => {
  if (Object.keys(req.body ?? {}).length) throw new HttpError(400, "Request body must be empty", "VALIDATION_ERROR");
  await updateMobileAppPresence((req as AuthedRequest).userId, true);
  res.status(204).send();
}));

meRouter.put("/app-presence", asyncHandler(async (req, res) => {
  if (typeof req.body?.present !== "boolean" || Object.keys(req.body).some((key) => key !== "present")) {
    throw new HttpError(400, "present must be a boolean", "VALIDATION_ERROR");
  }
  await updateMobileAppPresence((req as AuthedRequest).userId, req.body.present);
  res.status(204).send();
}));

meRouter.put("/profile-picture", asyncHandler(async (req, res) => {
  const uploadId = req.body?.uploadId;
  if (typeof uploadId !== "string" || !UUID_PATTERN.test(uploadId)) {
    throw new HttpError(400, "uploadId must be a UUID", "VALIDATION_ERROR");
  }
  res.json({ user: await updateProfilePicture((req as AuthedRequest).userId, uploadId) });
}));
meRouter.delete("/profile-picture", asyncHandler(async (_req, res) => {
  res.json({ user: await updateProfilePicture((_req as AuthedRequest).userId, null) });
}));

meRouter.get(
  "/addresses",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    res.json({ addresses: await listAddresses(userId) });
  })
);

meRouter.post(
  "/addresses",
  asyncHandler(async (req, res) => {
    const { userId } = req as AuthedRequest;
    const { alias } = req.body ?? {};
    if (typeof alias !== "string") {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "alias is required" } });
      return;
    }
    const address = await addAlias(userId, alias);
    res.status(201).json({ address });
  })
);

meRouter.patch("/addresses/:id", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id) || typeof req.body?.active !== "boolean" ||
      Object.keys(req.body ?? {}).some((key) => key !== "active")) {
    throw new HttpError(400, "id and boolean active are required", "VALIDATION_ERROR");
  }
  res.json({ address: await setAliasActive((req as AuthedRequest).userId, req.params.id, req.body.active) });
}));
meRouter.delete("/addresses/:id", asyncHandler(async (req, res) => {
  if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "address id must be a UUID", "VALIDATION_ERROR");
  await deleteAlias((req as AuthedRequest).userId, req.params.id);
  res.status(204).send();
}));

meRouter.get("/contacts", asyncHandler(async (req, res) => {
  const auth = req as AuthedRequest;
  const limit = Number(req.query.limit ?? 50);
  const offset = Number(req.query.offset ?? 0);
  res.json({ contacts: await listContacts(auth.userId, typeof req.query.q === "string" ? req.query.q : undefined, limit, offset) });
}));
meRouter.post("/contacts", asyncHandler(async (req, res) => {
  if (req.body?.country !== undefined && (typeof req.body.country !== "string" || req.body.country.length !== 2)) {
    throw new HttpError(400, "country must be a two-letter region code", "VALIDATION_ERROR");
  }
  res.status(201).json({ contact: await saveContact((req as AuthedRequest).userId, req.body ?? {}) });
}));
meRouter.patch("/contacts/:id", asyncHandler(async (req, res) => {
  if (req.body?.country !== undefined && (typeof req.body.country !== "string" || req.body.country.length !== 2)) {
    throw new HttpError(400, "country must be a two-letter region code", "VALIDATION_ERROR");
  }
  res.json({ contact: await saveContact((req as AuthedRequest).userId, req.body ?? {}, req.params.id) });
}));
meRouter.delete("/contacts/:id", asyncHandler(async (req, res) => {
  await deleteContact((req as AuthedRequest).userId, req.params.id);
  res.status(204).send();
}));
meRouter.post("/recipient-confirmation", asyncHandler(async (req, res) => {
  if (typeof req.body?.address !== "string" || req.body.address.length > 320) {
    throw new HttpError(400, "address must be a string of at most 320 characters", "VALIDATION_ERROR");
  }
  if (req.body.country !== undefined && (typeof req.body.country !== "string" || req.body.country.length !== 2)) {
    throw new HttpError(400, "country must be a two-letter region code", "VALIDATION_ERROR");
  }
  res.json(await confirmRecipient((req as AuthedRequest).userId, req.body.address, req.body.country));
}));
meRouter.get("/blocks", asyncHandler(async (req, res) => {
  const result = await query("SELECT blocked_user_id AS \"userId\", created_at AS \"createdAt\" FROM user_blocks WHERE blocker_user_id = $1 ORDER BY created_at DESC", [(req as AuthedRequest).userId]);
  res.json({ blocks: result.rows });
}));
meRouter.post("/blocks", asyncHandler(async (req, res) => {
  if (typeof req.body?.userId !== "string") throw new HttpError(400, "userId is required", "VALIDATION_ERROR");
  await setBlock((req as AuthedRequest).userId, req.body.userId, true);
  res.status(204).send();
}));
meRouter.delete("/blocks/:userId", asyncHandler(async (req, res) => {
  await setBlock((req as AuthedRequest).userId, req.params.userId, false);
  res.status(204).send();
}));
meRouter.get("/preferences", asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT COALESCE(sms_enabled,TRUE) AS sms_enabled, COALESCE(ivr_enabled,FALSE) AS ivr_enabled,
            COALESCE(discoverable,TRUE) AS discoverable, COALESCE(profile_visible,TRUE) AS profile_visible,
            COALESCE(read_receipts,TRUE) AS read_receipts, COALESCE(communication_enabled,TRUE) AS communication_enabled
       FROM (SELECT 1) seed
       LEFT JOIN notification_preferences np ON np.user_id = $1`,
    [(req as AuthedRequest).userId],
  );
  res.json({ preferences: result.rows[0] });
}));
meRouter.patch("/preferences", asyncHandler(async (req, res) => {
  const allowed = ["smsEnabled", "ivrEnabled", "discoverable", "profileVisible", "readReceipts", "communicationEnabled"] as const;
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).length === 0 ||
      Object.keys(req.body).some((key) => !(allowed as readonly string[]).includes(key))) {
    throw new HttpError(400, "At least one supported preference is required", "VALIDATION_ERROR");
  }
  for (const key of allowed) if (req.body?.[key] !== undefined && typeof req.body[key] !== "boolean") throw new HttpError(400, `${key} must be boolean`, "VALIDATION_ERROR");
  const auth = req as AuthedRequest;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockChangeAccounts(client, [auth.userId]);
    const result = await client.query(
      `INSERT INTO notification_preferences (user_id, sms_enabled, ivr_enabled, discoverable, profile_visible, read_receipts, communication_enabled)
       VALUES ($1, COALESCE($2, TRUE), COALESCE($3, FALSE), COALESCE($4, TRUE), COALESCE($5, TRUE), COALESCE($6, TRUE), COALESCE($7, TRUE))
       ON CONFLICT (user_id) DO UPDATE SET
         sms_enabled = COALESCE($2, notification_preferences.sms_enabled),
         ivr_enabled = COALESCE($3, notification_preferences.ivr_enabled),
         discoverable = COALESCE($4, notification_preferences.discoverable),
         profile_visible = COALESCE($5, notification_preferences.profile_visible),
         read_receipts = COALESCE($6, notification_preferences.read_receipts),
         communication_enabled = COALESCE($7, notification_preferences.communication_enabled),
         updated_at = now()
       RETURNING sms_enabled, ivr_enabled, discoverable, profile_visible, read_receipts, communication_enabled`,
      [auth.userId, req.body?.smsEnabled ?? null, req.body?.ivrEnabled ?? null, req.body?.discoverable ?? null, req.body?.profileVisible ?? null, req.body?.readReceipts ?? null, req.body?.communicationEnabled ?? null],
    );
    await recordChange(client, auth.userId, "preferences", auth.userId, "upserted", result.rows[0]);
    await recordSecurityEvent(client, {
      userId: auth.userId,
      eventType: "privacy_settings_changed",
      metadata: { setting: "notification_preferences", value: JSON.stringify(req.body) },
      notifyOwner: true,
    });
    await client.query("COMMIT");
    res.json({ preferences: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}));
