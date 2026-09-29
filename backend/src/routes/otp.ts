import { Router } from "express";
import { asyncHandler, HttpError } from "../httpError";
import {
  getNotificationCapabilities,
  handleProviderWebhook,
  requestOtp,
  verifyOtp,
  requestDurableOtp,
  verifyDurableOtp,
} from "../auth/otpService";
import type { NotificationChannel, ProviderEvent } from "../notifications/provider";
import { telecomCapabilities } from "../services/telecomService";

export const otpRouter = Router();

otpRouter.post("/request", asyncHandler(async (req, res) => {
  const { phone, country, purpose, channel } = req.body ?? {};
  if (typeof phone !== "string" || typeof purpose !== "string" ||
      (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
      (channel !== undefined && channel !== "sms" && channel !== "ivr")) {
    throw new HttpError(400, "phone, purpose, and an optional valid channel are required", "VALIDATION_ERROR");
  }
  res.status(202).json(await requestDurableOtp({ phone, country, purpose, channel: channel as NotificationChannel, ipAddress: req.ip }));
}));

otpRouter.post("/verify", asyncHandler(async (req, res) => {
  const { challengeId, phone, country, purpose, code } = req.body ?? {};
  if (typeof challengeId !== "string" || typeof phone !== "string" ||
      (country !== undefined && (typeof country !== "string" || country.length !== 2)) ||
      typeof purpose !== "string" || typeof code !== "string") {
    throw new HttpError(400, "challengeId, phone, purpose, and code are required", "VALIDATION_ERROR");
  }
  if (purpose === "phone_change") {
    throw new HttpError(400, "Phone-change verification must be consumed by the authenticated phone-change operation", "OTP_PURPOSE_INVALID");
  }
  res.json(await verifyDurableOtp({ challengeId, phone, country, purpose, code }));
}));

otpRouter.post("/webhook", asyncHandler(async (req, res) => {
  const timestamp = req.header("X-Provider-Timestamp") ?? "";
  const signature = req.header("X-Provider-Signature") ?? "";
  const event = req.body?.event as ProviderEvent | undefined;
  if (!event || typeof event.id !== "string" || typeof event.requestId !== "string" ||
      typeof event.status !== "string" || typeof event.sequence !== "number" || typeof event.occurredAt !== "number") {
    throw new HttpError(400, "A valid provider event is required", "VALIDATION_ERROR");
  }
  const result = await handleProviderWebhook(JSON.stringify(req.body), timestamp, signature, event);
  res.json({ accepted: true, result });
}));

otpRouter.get("/capabilities", (_req, res) => {
  res.json({ notifications: telecomCapabilities(), otpVerification: getNotificationCapabilities() });
});
