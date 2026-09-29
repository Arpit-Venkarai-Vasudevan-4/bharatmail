import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db";
import { HttpError } from "../httpError";
import { emailFromPhone, lockPhoneIdentities, normalizePhone, parsePhone, type ParsedPhone } from "../phone";
import { passwordProvider } from "../auth/passwordProvider";
import { config } from "../config";
import { lockChangeAccounts, recordChange } from "./stage2Service";
import { recordSecurityEvent } from "./securityEventService";
import { notificationBody, publicWebhookUrl, TwilioMessagingAdapter, type SmsSendResult, type TwilioForm } from "../notifications/twilio";

const TERMS_VERSION = "mvp-1";
const MAX_IVR_ATTEMPTS = 3;
const accountSidPattern = /^AC[0-9a-fA-F]{32}$/;
const messageSidPattern = /^(SM|MM)[0-9a-fA-F]{32}$/;
const callSidPattern = /^CA[0-9a-fA-F]{32}$/;

function requiredField(form: TwilioForm, name: string, maxLength = 2048): string {
  const value = form[name];
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new HttpError(400, `Provider field ${name} is invalid`, "WEBHOOK_INVALID");
  }
  return value;
}

function formHash(form: TwilioForm): string {
  const canonical = Object.keys(form).sort().map((key) => {
    const value = form[key];
    return `${key}=${Array.isArray(value) ? [...new Set(value)].sort().join("\u0000") : value}`;
  }).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function consentTwiML(prompt: string): string {
  const action = publicWebhookUrl(config.twilio.publicUrl, "/api/telecom/ivr/decision");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="5" actionOnEmptyResult="true" method="POST" action="${action.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"><Say>${prompt}</Say></Gather><Say>We did not receive your response. No account was created.</Say><Hangup/></Response>`;
}

function messageTwiML(body: string): string {
  const safe = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}

function verifyAccount(form: TwilioForm, validateDestination = true): void {
  const accountSid = requiredField(form, "AccountSid", 64);
  if (!accountSidPattern.test(accountSid) || accountSid !== config.twilio.accountSid) {
    throw new HttpError(401, "Webhook account does not match the configured provider account", "WEBHOOK_INVALID");
  }
  const to = validateDestination ? requiredField(form, "To", 32) : undefined;
  let normalizedTo: string | undefined;
  if (typeof to === "string") {
    try { normalizedTo = normalizePhone(to); }
    catch { throw new HttpError(401, "Webhook destination is not a valid international phone number", "WEBHOOK_INVALID"); }
  }
  if (config.twilio.phoneNumber && typeof to === "string") {
    const configuredNumber = normalizePhone(config.twilio.phoneNumber);
    if (normalizedTo !== configuredNumber) {
      throw new HttpError(401, "Webhook destination does not match the configured sender", "WEBHOOK_INVALID");
    }
  }
}

async function createSignupAccount(client: { query: (text: string, values?: any[]) => Promise<any> }, parsedPhone: ParsedPhone, channel: "sms" | "ivr") {
  const phone = parsedPhone.normalized;
  await lockPhoneIdentities(client, [phone]);
  const existing = await client.query(
    "SELECT id,account_status FROM users WHERE phone_normalized=$1 FOR UPDATE",
    [phone],
  );
  if (existing.rows[0]) return existing.rows[0].account_status === "active" ? { result: "existing" as const, userId: existing.rows[0].id } : { result: "unavailable" as const, userId: null };
  const address = emailFromPhone(phone, config.mailDomain);
  const retired = await client.query("SELECT 1 FROM phone_history WHERE phone_normalized=$1 OR address=$2", [phone, address]);
  if (retired.rowCount) return { result: "unavailable" as const, userId: null };
  const legacyCollision = await client.query(
    `SELECT 1 FROM users WHERE phone_country IS NULL AND phone_normalized=$1
     UNION ALL SELECT 1 FROM phone_history WHERE phone_country IS NULL AND phone_normalized=$1 LIMIT 1`,
    [parsedPhone.nationalNumber],
  );
  if (legacyCollision.rowCount) return { result: "unavailable" as const, userId: null };
  const reservedAddress = await client.query("SELECT 1 FROM addresses WHERE email=$1", [address]);
  if (reservedAddress.rowCount) return { result: "unavailable" as const, userId: null };
  const passwordHash = await passwordProvider.prepareSecret(randomBytes(32).toString("base64url"));
  if (!passwordHash) throw new HttpError(500, "Could not initialize the account credential boundary", "INTERNAL_ERROR");
  const provenance = channel === "sms" ? "twilio_inbound_sms" : "unknown";
  const inserted = await client.query(
    `INSERT INTO users(phone_normalized,phone_e164,phone_country,password_hash,display_name,language,signup_channel,has_mobile_app,
        phone_verified_at,phone_verification_provenance,terms_accepted_at,terms_version)
     VALUES($1,$2,$3,$4,NULL,'en',$5,FALSE,CASE WHEN $5='sms' THEN now() ELSE NULL END,$6,now(),$7) RETURNING id`,
    [phone, parsedPhone.e164, parsedPhone.country, passwordHash, channel, provenance, TERMS_VERSION],
  );
  await client.query("INSERT INTO addresses(user_id,email,is_primary,is_alias) VALUES($1,$2,TRUE,FALSE)", [inserted.rows[0].id, address]);
  await recordChange(client, inserted.rows[0].id, "account", inserted.rows[0].id, "upserted", {
    phone,
    email: address,
    signupChannel: channel,
    hasMobileApp: false,
    phoneVerificationProvenance: provenance,
  });
  await recordSecurityEvent(client, {
    userId: inserted.rows[0].id,
    eventType: "account_created",
    metadata: { authMethod: "telecom", channel },
    notifyOwner: true,
  });
  if (channel === "sms") {
    await recordSecurityEvent(client, {
      userId: inserted.rows[0].id,
      eventType: "phone_proof_accepted",
      metadata: { verificationMethod: provenance },
      notifyOwner: true,
    });
  }
  return { result: "created" as const, userId: inserted.rows[0].id };
}

async function beginWebhook(client: { query: (text: string, values?: any[]) => Promise<any> }, key: string, kind: string, hash: string) {
  const inserted = await client.query(
    "INSERT INTO telecom_webhook_events(event_key,event_kind,payload_hash) VALUES($1,$2,$3) ON CONFLICT(event_key) DO NOTHING RETURNING event_key",
    [key, kind, hash],
  );
  if (inserted.rowCount) return { duplicate: false as const, response: null };
  const existing = await client.query(
    "SELECT payload_hash,response_body FROM telecom_webhook_events WHERE event_key=$1 FOR UPDATE",
    [key],
  );
  if (!existing.rows[0] || existing.rows[0].payload_hash !== hash) {
    throw new HttpError(409, "Provider event identifier was reused with different content", "WEBHOOK_CONFLICT");
  }
  if (existing.rows[0].response_body === null) {
    throw new HttpError(503, "Provider event processing is incomplete", "WEBHOOK_RETRY", true);
  }
  return { duplicate: true as const, response: existing.rows[0].response_body };
}

async function finishWebhook(client: { query: (text: string, values?: any[]) => Promise<any> }, key: string, response: string) {
  await client.query("UPDATE telecom_webhook_events SET response_body=$2,completed_at=now() WHERE event_key=$1", [key, response]);
}

export async function handleInboundSms(form: TwilioForm): Promise<string> {
  verifyAccount(form);
  const messageSid = requiredField(form, "MessageSid", 64);
  if (!messageSidPattern.test(messageSid)) throw new HttpError(400, "Provider message SID is invalid", "WEBHOOK_INVALID");
  const rawPhone = requiredField(form, "From", 32);
  let parsedPhone: ParsedPhone;
  try { parsedPhone = parsePhone(rawPhone); }
  catch { throw new HttpError(400, "Provider sender must be a valid E.164 phone number", "WEBHOOK_INVALID"); }
  const phone = parsedPhone.normalized;
  const body = requiredField(form, "Body", 1600).trim();
  const client = await pool.connect();
  const eventKey = `sms:${messageSid}`;
  try {
    await client.query("BEGIN");
    const event = await beginWebhook(client, eventKey, "sms_inbound", formHash(form));
    if (event.duplicate) {
      await client.query("COMMIT");
      return event.response!;
    }
    const command = body.toUpperCase().replace(/\s+/g, " ");
    let response: string;
    if (command === "JOIN") {
      response = messageTwiML("Reply JOIN YES to create an account and accept PhoneMail terms version MVP-1.");
    } else if (command === "JOIN YES") {
      const account = await createSignupAccount(client, parsedPhone, "sms");
      response = messageTwiML(
        account.result === "created" ? "Your PhoneMail account has been created. Sign in using the verification code sent to this phone." :
        account.result === "existing" ? "A PhoneMail account already exists for this number. Sign in to continue." :
        "This number cannot be registered. Contact support for help.",
      );
    } else if (command === "STOP") {
      const user = await client.query<{ id: string }>("SELECT id FROM users WHERE phone_normalized=$1 AND account_status='active'", [phone]);
      if (user.rows[0]) {
        await lockChangeAccounts(client, [user.rows[0].id]);
        const preferences = await client.query(
          `INSERT INTO notification_preferences(user_id,sms_enabled) VALUES($1,FALSE)
           ON CONFLICT(user_id) DO UPDATE SET sms_enabled=FALSE RETURNING sms_enabled`,
          [user.rows[0].id],
        );
        await recordChange(client, user.rows[0].id, "preferences", user.rows[0].id, "upserted", preferences.rows[0]);
        await recordSecurityEvent(client, {
          userId: user.rows[0].id,
          eventType: "security_setting_changed",
          metadata: { setting: "smsNotifications", active: false },
        });
      }
      response = messageTwiML("PhoneMail SMS notifications have been stopped where an account is associated with this number.");
    } else {
      response = messageTwiML("To register, reply JOIN. To stop PhoneMail SMS notifications, reply STOP.");
    }
    await finishWebhook(client, eventKey, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function handleInboundCall(form: TwilioForm): Promise<string> {
  verifyAccount(form);
  const callSid = requiredField(form, "CallSid", 64);
  if (!callSidPattern.test(callSid)) throw new HttpError(400, "Provider call SID is invalid", "WEBHOOK_INVALID");
  const rawPhone = requiredField(form, "From", 32);
  let parsedPhone: ParsedPhone;
  try { parsedPhone = parsePhone(rawPhone); }
  catch { throw new HttpError(400, "Provider caller must be a valid E.164 phone number", "WEBHOOK_INVALID"); }
  const phone = parsedPhone.normalized;
  const key = `voice:start:${callSid}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await beginWebhook(client, key, "voice_inbound", formHash(form));
    if (event.duplicate) {
      await client.query("COMMIT");
      return event.response!;
    }
    const existing = await client.query<{ phone_normalized: string }>(
      "SELECT phone_normalized FROM telecom_ivr_calls WHERE call_sid=$1 FOR UPDATE",
      [callSid],
    );
    if (existing.rows[0] && existing.rows[0].phone_normalized !== phone) {
      throw new HttpError(409, "Provider call SID is bound to another caller", "WEBHOOK_CONFLICT");
    }
    await client.query(
      "INSERT INTO telecom_ivr_calls(call_sid,phone_normalized,phone_e164,phone_country) VALUES($1,$2,$3,$4) ON CONFLICT(call_sid) DO NOTHING",
      [callSid, phone, parsedPhone.e164, parsedPhone.country],
    );
    const response = consentTwiML("Welcome to PhoneMail. Press 1 to consent to the terms and create an account. Press 2 to hear this message again.");
    await finishWebhook(client, key, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function handleIvrDecision(form: TwilioForm): Promise<string> {
  verifyAccount(form);
  const callSid = requiredField(form, "CallSid", 64);
  if (!callSidPattern.test(callSid)) throw new HttpError(400, "Provider call SID is invalid", "WEBHOOK_INVALID");
  const rawDigits = form.Digits;
  const digits = rawDigits === undefined || rawDigits === "" ? "" : requiredField(form, "Digits", 8);
  const key = `voice:decision:${callSid}:${formHash(form)}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const event = await beginWebhook(client, key, "voice_decision", formHash(form));
    if (event.duplicate) {
      await client.query("COMMIT");
      return event.response!;
    }
    const call = await client.query<{ phone_normalized: string; attempts: number; status: string }>(
      "SELECT phone_normalized,attempts,status FROM telecom_ivr_calls WHERE call_sid=$1 FOR UPDATE",
      [callSid],
    );
    if (!call.rows[0]) throw new HttpError(404, "IVR call session was not found", "NOT_FOUND");
    if (form.From !== undefined && normalizePhone(requiredField(form, "From", 32)) !== call.rows[0].phone_normalized) {
      throw new HttpError(401, "IVR caller does not match the signed call session", "WEBHOOK_INVALID");
    }
    let response: string;
    if (call.rows[0].status !== "awaiting_consent") {
      response = "<Response><Say>This registration call has already been completed.</Say><Hangup/></Response>";
    } else if (digits === "") {
      await client.query("UPDATE telecom_ivr_calls SET status='timed_out',attempts=attempts+1,updated_at=now() WHERE call_sid=$1", [callSid]);
      response = "<Response><Say>No input was received. No account was created.</Say><Hangup/></Response>";
    } else if (digits === "1") {
      const caller = await client.query<{ phone_e164: string; phone_country: string | null }>(
        "SELECT phone_e164,phone_country FROM telecom_ivr_calls WHERE call_sid=$1",
        [callSid],
      );
      const parsedPhone = parsePhone(caller.rows[0].phone_e164, caller.rows[0].phone_country ?? undefined);
      const account = await createSignupAccount(client, parsedPhone, "ivr");
      const status = account.result === "created" ? "created" : account.result === "existing" ? "existing" : "unavailable";
      await client.query(
        "UPDATE telecom_ivr_calls SET status=$2,user_id=$3,consented_at=now(),updated_at=now() WHERE call_sid=$1",
        [callSid, status, account.userId],
      );
      const say = account.result === "created" ? "Your PhoneMail account has been created." :
        account.result === "existing" ? "A PhoneMail account already exists for this number." :
        "This number cannot be registered. No account was created.";
      response = `<Response><Say>${say}</Say><Hangup/></Response>`;
    } else {
      const attempts = call.rows[0].attempts + 1;
      const exhausted = attempts >= MAX_IVR_ATTEMPTS;
      await client.query(
        "UPDATE telecom_ivr_calls SET attempts=$2,status=$3,updated_at=now() WHERE call_sid=$1",
        [callSid, attempts, exhausted ? "invalid" : "awaiting_consent"],
      );
      response = exhausted
        ? "<Response><Say>We could not understand your response. No account was created.</Say><Hangup/></Response>"
        : consentTwiML("Please press 1 to consent and create an account, or press 2 to hear the options again.");
    }
    await finishWebhook(client, key, response);
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function deliveryStatus(status: string): { status: "accepted" | "sent" | "delivered" | "failed"; rank: number } | null {
  switch (status.toLowerCase()) {
    case "queued":
    case "accepted":
      return { status: "accepted", rank: 1 };
    case "sending":
    case "sent":
      return { status: "sent", rank: 2 };
    case "delivered":
      return { status: "delivered", rank: 3 };
    case "failed":
    case "undelivered":
      return { status: "failed", rank: 3 };
    default:
      return null;
  }
}

export async function handleSmsStatus(deliveryId: string, form: TwilioForm): Promise<"applied" | "duplicate" | "stale"> {
  verifyAccount(form, false);
  if (!/^[0-9a-f-]{36}$/i.test(deliveryId)) throw new HttpError(400, "Notification delivery ID is invalid", "WEBHOOK_INVALID");
  const sid = requiredField(form, "MessageSid", 64);
  if (!messageSidPattern.test(sid)) throw new HttpError(400, "Provider message SID is invalid", "WEBHOOK_INVALID");
  const incoming = deliveryStatus(requiredField(form, "MessageStatus", 32));
  if (!incoming) return "stale";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const delivery = await client.query<{ status_rank: number; status: string; provider_message_sid: string | null }>(
      "SELECT status_rank,status,provider_message_sid FROM notification_deliveries WHERE id=$1 FOR UPDATE",
      [deliveryId],
    );
    if (!delivery.rows[0]) throw new HttpError(404, "Notification delivery was not found", "NOT_FOUND");
    if (delivery.rows[0].provider_message_sid && delivery.rows[0].provider_message_sid !== sid) {
      throw new HttpError(409, "Provider callback SID does not match the delivery", "WEBHOOK_CONFLICT");
    }
    const currentRank = delivery.rows[0].status_rank;
    if (incoming.rank <= currentRank) {
      await client.query("COMMIT");
      return incoming.rank === currentRank && incoming.status === delivery.rows[0].status ? "duplicate" : "stale";
    }
    await client.query(
      `UPDATE notification_deliveries SET provider_message_sid=$2,status=$3,status_rank=$4,updated_at=now()
       WHERE id=$1`,
      [deliveryId, sid, incoming.status, incoming.rank],
    );
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function messagingConfigured(): boolean {
  return Boolean(
    config.twilio.accountSid && (config.twilio.authToken || config.twilio.apiKeySid && config.twilio.apiKeySecret) &&
    (config.twilio.phoneNumber || config.twilio.messagingServiceSid) && config.twilio.publicUrl,
  );
}

export function telecomCapabilities() {
  const messaging = messagingConfigured();
  const webhook = Boolean(config.twilio.accountSid && config.twilio.authToken && config.twilio.publicUrl);
  return {
    sms: { supported: true, configured: messaging, simulated: !messaging, liveTested: false },
    ivr: { supported: true, configured: webhook, simulated: !webhook, liveTested: false },
    provider: messaging || webhook ? "twilio" : "local_simulation",
  };
}

export async function processMessageNotification(
  messageId: string,
  adapter = new TwilioMessagingAdapter(),
  enabled = messagingConfigured(),
): Promise<void> {
  const result = await pool.query<{
    recipient_user_id: string;
    phone_normalized: string;
    phone_e164: string | null;
    sms_enabled: boolean;
    has_mobile_app: boolean;
    sender_name: string | null;
    sender_phone: string;
    subject: string;
  }>(
    `SELECT DISTINCT recipient.id AS recipient_user_id,recipient.phone_normalized,recipient.phone_e164,
            COALESCE(np.sms_enabled,TRUE) AS sms_enabled,recipient.has_mobile_app,
            sender.display_name AS sender_name,sender.phone_normalized AS sender_phone,m.subject
       FROM messages m
       JOIN users sender ON sender.id=m.sender_user_id
       JOIN message_recipients mr ON mr.message_id=m.id
       JOIN users recipient ON recipient.id=mr.recipient_user_id
       LEFT JOIN notification_preferences np ON np.user_id=recipient.id
      WHERE m.id=$1 AND m.lifecycle_status='committed' AND recipient.account_status='active'
        AND recipient.phone_verified_at IS NOT NULL AND recipient.phone_e164 IS NOT NULL
      ORDER BY recipient.id LIMIT 50`,
    [messageId],
  );
  const eligible = result.rows.filter((recipient) => recipient.sms_enabled && !recipient.has_mobile_app);
  const sendOne = async (recipient: typeof eligible[number]) => {
    const inserted = await pool.query<{ id: string; status: string }>(
      `INSERT INTO notification_deliveries(message_id,recipient_user_id)
       VALUES($1,$2) ON CONFLICT(message_id,recipient_user_id) DO NOTHING RETURNING id,status`,
      [messageId, recipient.recipient_user_id],
    );
    const delivery = inserted.rows[0] ?? (await pool.query<{ id: string; status: string }>(
      "SELECT id,status FROM notification_deliveries WHERE message_id=$1 AND recipient_user_id=$2",
      [messageId, recipient.recipient_user_id],
    )).rows[0];
    if (!delivery || ["accepted", "sent", "delivered", "failed", "simulated"].includes(delivery.status)) return;
    if (!enabled) {
      await pool.query(
        "UPDATE notification_deliveries SET status='simulated',updated_at=now() WHERE id=$1 AND status='queued'",
        [delivery.id],
      );
      return;
    }
    const sender = recipient.sender_name?.trim() || recipient.sender_phone;
    const body = notificationBody(sender, recipient.subject);
    const callback = publicWebhookUrl(config.twilio.publicUrl, `/api/telecom/messaging/status?deliveryId=${encodeURIComponent(delivery.id)}`);
    try {
      const sent: SmsSendResult = await adapter.send({
        to: recipient.phone_e164!,
        body,
        statusCallback: callback,
        templateVariables: { sender, subject: recipient.subject },
      });
      const rank = sent.status === "accepted" ? 1 : sent.status === "sent" ? 2 : 3;
      await pool.query(
        `UPDATE notification_deliveries SET provider_message_sid=$2,status=$3,status_rank=GREATEST(status_rank,$4),
           attempt_count=attempt_count+1,last_error=NULL,updated_at=now()
         WHERE id=$1 AND status_rank <= $4`,
        [delivery.id, sent.sid, sent.status, rank],
      );
    } catch (error) {
      await pool.query(
        "UPDATE notification_deliveries SET attempt_count=attempt_count+1,last_error='provider send failed',updated_at=now() WHERE id=$1",
        [delivery.id],
      );
      throw error;
    }
  };
  for (let index = 0; index < eligible.length; index += 5) {
    const outcomes = await Promise.allSettled(eligible.slice(index, index + 5).map(sendOne));
    const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
  }
}
