import assert from "node:assert/strict";
import test from "node:test";
process.env.DATABASE_URL = "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = "test-secret";
const {
  getLocalOtpCode,
  getNotificationCapabilities,
  handleProviderWebhook,
  requestOtp,
  resetOtpStateForTests,
  signProviderWebhook,
  verifyOtp,
} = require("../src/auth/otpService") as typeof import("../src/auth/otpService");
const { TwilioVerifyAdapter } = require("../src/auth/otpProvider") as typeof import("../src/auth/otpProvider");

test.beforeEach(() => resetOtpStateForTests());

test("local notification capability reports simulation instead of live availability", () => {
  const capabilities = getNotificationCapabilities();
  assert.deepEqual(capabilities.sms, { supported: true, configured: false, simulated: true, liveTested: false });
  assert.deepEqual(capabilities.ivr, { supported: true, configured: false, simulated: false, liveTested: false });
});

test("local OTP binds purpose and phone and is single-use", async () => {
  const requested = await requestOtp({ phone: "+44 7911 123456", purpose: "login", now: 1_000_000 });
  const code = getLocalOtpCode(requested.challengeId);
  assert.ok(code);
  assert.throws(
    () => verifyOtp({ challengeId: requested.challengeId, phone: "+44 7911 123456", purpose: "signup", code, now: 1_000_001 }),
    (error: { code?: string }) => error.code === "OTP_INVALID"
  );
  assert.deepEqual(
    verifyOtp({ challengeId: requested.challengeId, phone: "07911 123456", country: "GB", purpose: "login", code, now: 1_000_001 }),
    { verified: true, challengeId: requested.challengeId, phone: "447911123456", purpose: "login" }
  );
  assert.throws(() => verifyOtp({ challengeId: requested.challengeId, phone: "+447911123456", purpose: "login", code, now: 1_000_002 }));
});

test("provider webhooks reject bad signatures and deduplicate stale events", async () => {
  const payload = JSON.stringify({ event: { id: "evt-1", requestId: "req-1", status: "delivered", sequence: 2, occurredAt: 10 } });
  const timestamp = String(Date.now());
  const event = { id: "evt-1", requestId: "req-1", status: "delivered" as const, sequence: 2, occurredAt: 10 };
  await assert.rejects(() => handleProviderWebhook(payload, timestamp, "bad", event));
  const signature = signProviderWebhook(payload, timestamp);
  assert.equal(await handleProviderWebhook(payload, timestamp, signature, event), "applied");
  assert.equal(await handleProviderWebhook(payload, timestamp, signature, event), "duplicate");
  const stale = { ...event, id: "evt-2", sequence: 1, status: "sent" as const };
  const stalePayload = JSON.stringify({ event: stale });
  assert.equal(await handleProviderWebhook(stalePayload, timestamp, signProviderWebhook(stalePayload, timestamp), stale), "stale");
});

test("OTP resend cooldown tracks the latest canonical phone send", async () => {
  const first = await requestOtp({ phone: "+447911123457", purpose: "login", now: 2_000_000 });
  assert.ok(first.challengeId);
  await assert.rejects(
    () => requestOtp({ phone: "07911 123457", country: "GB", purpose: "login", now: 2_000_001 }),
    (error: { code?: string; fields?: Record<string, string> }) => error.code === "OTP_RESEND_COOLDOWN" && error.fields?.retryAfter === "30"
  );
  await requestOtp({ phone: "07911 123457", country: "GB", purpose: "login", now: 2_030_001 });
  await assert.rejects(
    () => requestOtp({ phone: "+44 (7911) 123457", purpose: "login", now: 2_030_002 }),
    (error: { code?: string }) => error.code === "OTP_RESEND_COOLDOWN"
  );
});

test("Twilio Verify checks the provider-issued code and does not fall back locally", async () => {
  const verificationSid = `VE${"a".repeat(32)}`;
  let capturedUrl = "";
  let capturedBody = "";
  let capturedAuthorization = "";
  const adapter = new TwilioVerifyAdapter(async (url, init) => {
    capturedUrl = url;
    capturedBody = String(init.body);
    capturedAuthorization = String((init.headers as Record<string, string>).Authorization);
    return new URLSearchParams(capturedBody).get("VerificationSid") === verificationSid
      ? new Response(JSON.stringify({ status: "approved" }), { status: 200 })
      : new Response("not found", { status: 404 });
  }, {
    accountSid: "test-account",
    authToken: "test-auth-token",
    apiKeySid: "",
    apiKeySecret: "",
    verifyServiceSid: "VA-test",
    timeoutMs: 100,
  });
  assert.equal(await adapter.check(verificationSid, "123456"), true);
  assert.match(capturedUrl, /\/Services\/VA-test\/VerificationCheck$/);
  assert.equal(new URLSearchParams(capturedBody).get("VerificationSid"), verificationSid);
  assert.equal(new URLSearchParams(capturedBody).get("Code"), "123456");
  assert.match(capturedAuthorization, /^Basic /);

  const unavailable = new TwilioVerifyAdapter(async () => new Response("unavailable", { status: 503 }), {
    accountSid: "test-account",
    authToken: "test-auth-token",
    apiKeySid: "",
    apiKeySecret: "",
    verifyServiceSid: "VA-test",
    timeoutMs: 100,
  });
  await assert.rejects(() => unavailable.check(verificationSid, "123456"), (error: { code?: string }) => error.code === "PROVIDER_REJECTED");
  await assert.rejects(() => adapter.check(`VE${"b".repeat(32)}`, "123456"), (error: { code?: string }) => error.code === "PROVIDER_REJECTED");
});

test("Twilio Verify timeout is bounded and returns unavailable", async () => {
  const adapter = new TwilioVerifyAdapter((_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }), {
    accountSid: "test-account",
    authToken: "test-auth-token",
    apiKeySid: "",
    apiKeySecret: "",
    verifyServiceSid: "VA-test",
    timeoutMs: 5,
  });
  await assert.rejects(() => adapter.check(`VE${"a".repeat(32)}`, "123456"), (error: { code?: string; retryable?: boolean }) =>
    error.code === "PROVIDER_UNAVAILABLE" && error.retryable === true);
});

test("Twilio Verify start binds a provider-issued verification SID", async () => {
  let capturedUrl = "";
  let capturedBody = "";
  const verificationSid = `VE${"c".repeat(32)}`;
  const adapter = new TwilioVerifyAdapter(async (url, init) => {
    capturedUrl = url;
    capturedBody = String(init.body);
    return new Response(JSON.stringify({ sid: verificationSid, status: "pending" }), { status: 201 });
  }, {
    accountSid: "test-account",
    authToken: "test-auth-token",
    apiKeySid: "",
    apiKeySecret: "",
    verifyServiceSid: "VA-start",
    timeoutMs: 100,
  });
  assert.equal(await adapter.start("919876543210", "sms"), verificationSid);
  assert.match(capturedUrl, /\/Services\/VA-start\/Verifications$/);
  assert.equal(new URLSearchParams(capturedBody).get("To"), "+919876543210");
  assert.equal(new URLSearchParams(capturedBody).get("Channel"), "sms");

  const malformed = new TwilioVerifyAdapter(async () => new Response(JSON.stringify({ sid: "not-a-VE-sid" }), { status: 201 }), {
    accountSid: "test-account",
    authToken: "test-auth-token",
    apiKeySid: "",
    apiKeySecret: "",
    verifyServiceSid: "VA-start",
    timeoutMs: 100,
  });
  await assert.rejects(() => malformed.start("919876543210"), (error: { code?: string }) => error.code === "PROVIDER_MALFORMED");
});
