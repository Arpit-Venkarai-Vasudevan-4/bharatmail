import { Router } from "express";
import type { Request } from "express";
import { config } from "../config";
import { HttpError, asyncHandler } from "../httpError";
import { validTwilioSignature, publicWebhookUrl, type TwilioForm } from "../notifications/twilio";
import {
  handleInboundCall,
  handleInboundSms,
  handleIvrDecision,
  handleSmsStatus,
  telecomCapabilities,
} from "../services/telecomService";

export const telecomRouter = Router();

function signedForm(req: Request): TwilioForm {
  if (!req.is("application/x-www-form-urlencoded") || !req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new HttpError(415, "Twilio callbacks must use form-encoded POST requests", "WEBHOOK_INVALID");
  }
  const authToken = config.twilio.authToken;
  if (!authToken || !config.twilio.publicUrl) {
    throw new HttpError(503, "Twilio webhook validation is not configured", "PROVIDER_UNAVAILABLE", true);
  }
  const form = req.body as TwilioForm;
  if (Object.values(form).some((value) => typeof value !== "string" && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))) {
    throw new HttpError(400, "Twilio callback contains invalid form fields", "WEBHOOK_INVALID");
  }
  const signature = req.header("X-Twilio-Signature") ?? "";
  const url = publicWebhookUrl(config.twilio.publicUrl, req.originalUrl);
  if (!validTwilioSignature(authToken, signature, url, form)) {
    throw new HttpError(401, "Twilio callback signature is invalid", "WEBHOOK_INVALID");
  }
  return form;
}

function twiml(res: import("express").Response, body: string) {
  res.type("application/xml").send(body);
}

telecomRouter.get("/capabilities", (_req, res) => {
  res.json({ integrations: telecomCapabilities() });
});

telecomRouter.post("/sms/inbound", asyncHandler(async (req, res) => {
  twiml(res, await handleInboundSms(signedForm(req)));
}));

telecomRouter.post("/ivr/inbound", asyncHandler(async (req, res) => {
  twiml(res, await handleInboundCall(signedForm(req)));
}));

telecomRouter.post("/ivr/decision", asyncHandler(async (req, res) => {
  twiml(res, await handleIvrDecision(signedForm(req)));
}));

telecomRouter.post("/messaging/status", asyncHandler(async (req, res) => {
  const form = signedForm(req);
  const accountSid = form.AccountSid;
  if (accountSid !== config.twilio.accountSid) {
    throw new HttpError(401, "Webhook account does not match the configured provider account", "WEBHOOK_INVALID");
  }
  const deliveryId = req.query.deliveryId;
  if (typeof deliveryId !== "string") throw new HttpError(400, "deliveryId is required", "VALIDATION_ERROR");
  const result = await handleSmsStatus(deliveryId, form);
  res.json({ accepted: true, result });
}));

