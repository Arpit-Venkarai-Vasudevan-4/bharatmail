import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const fixtureAccountSid = "AC" + "a".repeat(32);
const fixtureToken = "isolated-twilio-fixture-token";
const fixturePublicUrl = process.env.PHONEMAIL_TEST_PUBLIC_URL ?? process.env.PHONEMAIL_TEST_URL ?? "http://127.0.0.1:3311";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://phonemail_test:phonemail_test@127.0.0.1:3310/phonemail_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "telecom-integration-secret";
process.env.TWILIO_ACCOUNT_SID = fixtureAccountSid;
process.env.TWILIO_AUTH_TOKEN = fixtureToken;
process.env.TWILIO_PUBLIC_URL = fixturePublicUrl;

const { base } = integrationTargets();
const { query } = require("../src/db") as typeof import("../src/db");
const {
  processMessageNotification,
} = require("../src/services/telecomService") as typeof import("../src/services/telecomService");
const { TwilioMessagingAdapter, twilioSignature } =
  require("../src/notifications/twilio") as typeof import("../src/notifications/twilio");
const toNumber = "+447911123456";

type Params = Record<string, string>;

async function signedPost(path: string, params: Params, signatureOverride?: string) {
  const body = new URLSearchParams(params).toString();
  const url = `${fixturePublicUrl}${path}`;
  const signature = signatureOverride ?? twilioSignature(fixtureToken, url, params);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body,
  });
  return { response, text: await response.text() };
}

function twilioFields(fields: Params): Params {
  return { AccountSid: fixtureAccountSid, To: toNumber, ...fields };
}

async function register(phone: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: "secret123", displayName: "Message sender", termsAccepted: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body;
}

async function sendTo(senderToken: string, phone: string, body: string, subject: string) {
  const create = await fetch(`${base}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + senderToken },
    body: JSON.stringify({ participantPhones: [phone] }),
  });
  const conversation = await create.json();
  assert.equal(create.status, 201, JSON.stringify(conversation));
  const send = await fetch(`${base}/api/conversations/${conversation.conversation.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + senderToken },
    body: JSON.stringify({ subject, body }),
  });
  const message = await send.json();
  assert.equal(send.status, 201, JSON.stringify(message));
  return { conversationId: conversation.conversation.id as string, messageId: message.message.id as string };
}

test("Twilio-signed SMS/IVR signup, consent, deduplication, app presence, and notification callbacks", async () => {
  const fromNumber = await randomTestPhone();
  const smsSid = "SM" + randomUUID().replace(/-/g, "");
  const smsRequest = twilioFields({ MessageSid: smsSid, From: fromNumber, Body: "JOIN" });
  const forged = await signedPost("/api/telecom/sms/inbound", smsRequest, "forged-signature");
  assert.equal(forged.response.status, 401);
  const joinPrompt = await signedPost("/api/telecom/sms/inbound", smsRequest);
  assert.equal(joinPrompt.response.status, 200);
  assert.match(joinPrompt.text, /JOIN YES/);
  const repeatedPrompt = await signedPost("/api/telecom/sms/inbound", smsRequest);
  assert.equal(repeatedPrompt.text, joinPrompt.text);
  const consentSid = "SM" + randomUUID().replace(/-/g, "");
  const smsConsent = await signedPost("/api/telecom/sms/inbound", twilioFields({
    MessageSid: consentSid,
    From: fromNumber,
    Body: "JOIN YES",
  }));
  assert.equal(smsConsent.response.status, 200);
  assert.match(smsConsent.text, /account has been created/i);
  const phone = fromNumber.replace("+", "");
  const smsUser = await query<{ id: string; signup_channel: string; has_mobile_app: boolean; phone_verified_at: Date | null; terms_version: string }>(
    "SELECT id,signup_channel,has_mobile_app,phone_verified_at,terms_version FROM users WHERE phone_normalized=$1",
    [phone],
  );
  assert.equal(smsUser.rows.length, 1);
  assert.deepEqual(
    { channel: smsUser.rows[0].signup_channel, app: smsUser.rows[0].has_mobile_app, verified: Boolean(smsUser.rows[0].phone_verified_at), terms: smsUser.rows[0].terms_version },
    { channel: "sms", app: false, verified: true, terms: "mvp-1" },
  );
  const smsSignupEvents = await query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type,payload FROM account_audit_events WHERE user_id=$1 ORDER BY event_type",
    [smsUser.rows[0].id],
  );
  assert.deepEqual(smsSignupEvents.rows.map((event) => event.event_type), ["account_created", "phone_proof_accepted"]);
  assert.ok(smsSignupEvents.rows.every((event) => !JSON.stringify(event.payload).includes("password")));
  const signupNotifications = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM security_notifications WHERE user_id=$1",
    [smsUser.rows[0].id],
  );
  assert.equal(signupNotifications.rows[0].count, 2);
  const capabilitiesResponse = await fetch(`${base}/api/telecom/capabilities`);
  const capabilities = await capabilitiesResponse.json();
  assert.deepEqual(capabilities.integrations.sms, { supported: true, configured: false, simulated: true, liveTested: false });
  assert.deepEqual(capabilities.integrations.ivr, { supported: true, configured: true, simulated: false, liveTested: false });
  const existingSmsAccount = await signedPost("/api/telecom/sms/inbound", twilioFields({
    MessageSid: "SM" + randomUUID().replace(/-/g, ""),
    From: fromNumber,
    Body: "JOIN YES",
  }));
  assert.match(existingSmsAccount.text, /already exists/i);

  const invalidCallSid = "CA" + randomUUID().replace(/-/g, "");
  const invalidCall = await signedPost("/api/telecom/ivr/inbound", twilioFields({ CallSid: invalidCallSid, From: "+919876543211" }));
  assert.equal(invalidCall.response.status, 200);
  assert.match(invalidCall.text, /<Gather/);
  const invalidDecisionFields = twilioFields({ CallSid: invalidCallSid, From: "+919876543211", Digits: "9" });
  const invalidDecision = await signedPost("/api/telecom/ivr/decision", invalidDecisionFields);
  assert.equal(invalidDecision.response.status, 200);
  assert.match(invalidDecision.text, /<Gather/);
  await signedPost("/api/telecom/ivr/decision", invalidDecisionFields);
  const afterDuplicate = await query<{ attempts: number }>("SELECT attempts FROM telecom_ivr_calls WHERE call_sid=$1", [invalidCallSid]);
  assert.equal(afterDuplicate.rows[0].attempts, 1);
  await signedPost("/api/telecom/ivr/decision", twilioFields({ CallSid: invalidCallSid, From: "+919876543211", Digits: "8" }));
  const exhausted = await signedPost("/api/telecom/ivr/decision", twilioFields({ CallSid: invalidCallSid, From: "+919876543211", Digits: "3" }));
  assert.match(exhausted.text, /No account was created/);
  const invalidStatus = await query<{ status: string; attempts: number }>("SELECT status,attempts FROM telecom_ivr_calls WHERE call_sid=$1", [invalidCallSid]);
  assert.deepEqual(invalidStatus.rows[0], { status: "invalid", attempts: 3 });

  const timeoutCallSid = "CA" + randomUUID().replace(/-/g, "");
  await signedPost("/api/telecom/ivr/inbound", twilioFields({ CallSid: timeoutCallSid, From: "+919876543212" }));
  const timeout = await signedPost("/api/telecom/ivr/decision", twilioFields({ CallSid: timeoutCallSid, From: "+919876543212", Digits: "" }));
  assert.match(timeout.text, /No input was received/);
  const timeoutStatus = await query<{ status: string }>("SELECT status FROM telecom_ivr_calls WHERE call_sid=$1", [timeoutCallSid]);
  assert.equal(timeoutStatus.rows[0].status, "timed_out");

  const successfulCallSid = "CA" + randomUUID().replace(/-/g, "");
  const ivrPhone = await randomTestPhone();
  const ivrStartFields = twilioFields({ CallSid: successfulCallSid, From: ivrPhone });
  const ivrStart = await signedPost("/api/telecom/ivr/inbound", ivrStartFields);
  assert.equal(ivrStart.response.status, 200);
  const repeatedStart = await signedPost("/api/telecom/ivr/inbound", ivrStartFields);
  assert.equal(repeatedStart.text, ivrStart.text);
  const repeatOptions = await signedPost("/api/telecom/ivr/decision", twilioFields({
    CallSid: successfulCallSid, From: ivrPhone, Digits: "2",
  }));
  assert.match(repeatOptions.text, /<Gather/);
  const accepted = await signedPost("/api/telecom/ivr/decision", twilioFields({
    CallSid: successfulCallSid, From: ivrPhone, Digits: "1",
  }));
  assert.match(accepted.text, /account has been created/i);
  const ivrUser = await query<{ id: string; signup_channel: string; phone_verified_at: Date | null; has_mobile_app: boolean }>(
    "SELECT id,signup_channel,phone_verified_at,has_mobile_app FROM users WHERE phone_normalized=$1",
    [ivrPhone.replace("+", "")],
  );
  assert.equal(ivrUser.rows.length, 1);
  assert.deepEqual(
    { channel: ivrUser.rows[0].signup_channel, verified: ivrUser.rows[0].phone_verified_at, app: ivrUser.rows[0].has_mobile_app },
    { channel: "ivr", verified: null, app: false },
  );
  const ivrSignupEvents = await query<{ event_type: string }>(
    "SELECT event_type FROM account_audit_events WHERE user_id=$1",
    [ivrUser.rows[0].id],
  );
  assert.deepEqual(ivrSignupEvents.rows.map((event) => event.event_type), ["account_created"]);
  const repeatedConsent = await signedPost("/api/telecom/ivr/decision", twilioFields({
    CallSid: successfulCallSid, From: ivrPhone, Digits: "1",
  }));
  assert.equal(repeatedConsent.text, accepted.text);
  const ivrAccountCount = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM users WHERE phone_normalized=$1",
    [ivrPhone.replace("+", "")],
  );
  assert.equal(ivrAccountCount.rows[0].count, 1);

  const sender = await register(await randomTestPhone());
  const message = await sendTo(sender.token, fromNumber, "The body is not included in SMS.", "Subject with safe text");
  const sentRequests: URLSearchParams[] = [];
  let providerSid = "";
  const messagingAdapter = new TwilioMessagingAdapter(async (_url, init) => {
    sentRequests.push(new URLSearchParams(String(init?.body)));
    providerSid = "SM" + randomUUID().replace(/-/g, "");
    return new Response(JSON.stringify({ sid: providerSid, status: "queued" }), { status: 201 });
  }, {
    accountSid: fixtureAccountSid,
    authToken: fixtureToken,
    apiKeySid: "",
    apiKeySecret: "",
    phoneNumber: toNumber,
    messagingServiceSid: "",
    approvedTemplateSid: "",
    timeoutMs: 1000,
  });
  await processMessageNotification(message.messageId, messagingAdapter, true);
  assert.equal(sentRequests.length, 1);
  assert.equal(sentRequests[0].get("To"), fromNumber);
  assert.equal(sentRequests[0].get("Body"), "You have received an email from Message sender. Subject: Subject with safe text.");
  assert.ok(!sentRequests[0].get("Body")!.includes("The body is not included"));
  const delivery = await query<{ id: string; status: string }>(
    "SELECT id,status FROM notification_deliveries WHERE message_id=$1 AND recipient_user_id=$2",
    [message.messageId, smsUser.rows[0].id],
  );
  assert.deepEqual(delivery.rows[0].status, "accepted");
  const callbackPath = `/api/telecom/messaging/status?deliveryId=${delivery.rows[0].id}`;
  const delivered = await signedPost(callbackPath, twilioFields({ MessageSid: providerSid, MessageStatus: "delivered" }));
  assert.equal(delivered.response.status, 200);
  assert.equal(JSON.parse(delivered.text).result, "applied");
  const duplicate = await signedPost(callbackPath, twilioFields({ MessageSid: providerSid, MessageStatus: "delivered" }));
  assert.equal(JSON.parse(duplicate.text).result, "duplicate");
  const stale = await signedPost(callbackPath, twilioFields({ MessageSid: providerSid, MessageStatus: "sent" }));
  assert.equal(JSON.parse(stale.text).result, "stale");
  const finalDelivery = await query<{ status: string; provider_message_sid: string }>(
    "SELECT status,provider_message_sid FROM notification_deliveries WHERE id=$1",
    [delivery.rows[0].id],
  );
  assert.deepEqual(finalDelivery.rows[0], { status: "delivered", provider_message_sid: providerSid });

  const ambiguousMessage = await sendTo(sender.token, fromNumber, "Provider accepted before the response was lost.", "Ambiguous provider result");
  let providerAcceptances = 0;
  const responseLostAdapter = new TwilioMessagingAdapter(async () => {
    providerAcceptances++;
    throw new Error("simulated response loss after provider acceptance");
  }, {
    accountSid: fixtureAccountSid,
    authToken: fixtureToken,
    apiKeySid: "",
    apiKeySecret: "",
    phoneNumber: toNumber,
    messagingServiceSid: "",
    approvedTemplateSid: "",
    timeoutMs: 1000,
  });
  await assert.rejects(processMessageNotification(ambiguousMessage.messageId, responseLostAdapter, true));
  const ambiguousDelivery = await query<{ id: string; status: string; attempt_count: number }>(
    "SELECT id,status,attempt_count FROM notification_deliveries WHERE message_id=$1 AND recipient_user_id=$2",
    [ambiguousMessage.messageId, smsUser.rows[0].id],
  );
  assert.deepEqual(ambiguousDelivery.rows[0], { id: ambiguousDelivery.rows[0].id, status: "queued", attempt_count: 1 });

  const retryAdapter = new TwilioMessagingAdapter(async () => {
    providerAcceptances++;
    providerSid = "SM" + randomUUID().replace(/-/g, "");
    return new Response(JSON.stringify({ sid: providerSid, status: "queued" }), { status: 201 });
  }, {
    accountSid: fixtureAccountSid,
    authToken: fixtureToken,
    apiKeySid: "",
    apiKeySecret: "",
    phoneNumber: toNumber,
    messagingServiceSid: "",
    approvedTemplateSid: "",
    timeoutMs: 1000,
  });
  await processMessageNotification(ambiguousMessage.messageId, retryAdapter, true);
  assert.equal(providerAcceptances, 2);
  const ambiguousCallback = await signedPost(
    `/api/telecom/messaging/status?deliveryId=${ambiguousDelivery.rows[0].id}`,
    twilioFields({ MessageSid: providerSid, MessageStatus: "delivered" }),
  );
  assert.equal(JSON.parse(ambiguousCallback.text).result, "applied");
  const recoveredDelivery = await query<{ status: string; attempt_count: number }>(
    "SELECT status,attempt_count FROM notification_deliveries WHERE id=$1",
    [ambiguousDelivery.rows[0].id],
  );
  assert.deepEqual(recoveredDelivery.rows[0], { status: "delivered", attempt_count: 2 });

  await query("UPDATE users SET has_mobile_app=TRUE WHERE id=$1", [smsUser.rows[0].id]);
  const appInstalledMessage = await sendTo(sender.token, fromNumber, "Mobile app installed.", "App presence");
  await processMessageNotification(appInstalledMessage.messageId, messagingAdapter, true);
  const appSuppressed = await query(
    "SELECT 1 FROM notification_deliveries WHERE message_id=$1 AND recipient_user_id=$2",
    [appInstalledMessage.messageId, smsUser.rows[0].id],
  );
  assert.equal(appSuppressed.rows.length, 0);

  await query("UPDATE users SET has_mobile_app=FALSE WHERE id=$1", [smsUser.rows[0].id]);
  const stopSms = await signedPost("/api/telecom/sms/inbound", twilioFields({
    MessageSid: "SM" + randomUUID().replace(/-/g, ""),
    From: fromNumber,
    Body: "STOP",
  }));
  assert.equal(stopSms.response.status, 200);
  const stopAudit = await query<{ event_type: string; payload: Record<string, unknown> }>(
    "SELECT event_type,payload FROM account_audit_events WHERE user_id=$1 AND event_type='security_setting_changed'",
    [smsUser.rows[0].id],
  );
  assert.equal(stopAudit.rows[0].event_type, "security_setting_changed");
  assert.deepEqual(stopAudit.rows[0].payload, { setting: "smsNotifications", active: false });
  const optedOut = await query<{ sms_enabled: boolean }>("SELECT sms_enabled FROM notification_preferences WHERE user_id=$1", [smsUser.rows[0].id]);
  assert.equal(optedOut.rows[0].sms_enabled, false);
  const notificationsDisabledMessage = await sendTo(sender.token, fromNumber, "SMS disabled.", "Preferences");
  await processMessageNotification(notificationsDisabledMessage.messageId, messagingAdapter, true);
  const preferencesSuppressed = await query(
    "SELECT 1 FROM notification_deliveries WHERE message_id=$1 AND recipient_user_id=$2",
    [notificationsDisabledMessage.messageId, smsUser.rows[0].id],
  );
  assert.equal(preferencesSuppressed.rows.length, 0);

  const appPresence = await fetch(`${base}/api/me/app-presence`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: "Bearer " + sender.token },
    body: JSON.stringify({ present: false }),
  });
  assert.equal(appPresence.status, 204);
  const senderPresence = await query<{ has_mobile_app: boolean }>("SELECT has_mobile_app FROM users WHERE id=$1", [sender.user.id]);
  assert.equal(senderPresence.rows[0].has_mobile_app, false);
});
