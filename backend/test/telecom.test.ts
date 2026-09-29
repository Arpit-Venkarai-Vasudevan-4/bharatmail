import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://localhost/phonemail_test";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "telecom-unit-test-secret";
process.env.NODE_ENV = "development";

const {
  TwilioMessagingAdapter,
  notificationBody,
  publicWebhookUrl,
  twilioSignature,
  validTwilioSignature,
} = require("../src/notifications/twilio") as typeof import("../src/notifications/twilio");

const settings = {
  accountSid: "AC" + "a".repeat(32),
  authToken: "unit-auth-token",
  apiKeySid: "",
  apiKeySecret: "",
  phoneNumber: "+14155550100",
  messagingServiceSid: "",
  approvedTemplateSid: "HX" + "b".repeat(32),
  timeoutMs: 1000,
};

test("Twilio request signatures bind the exact public URL and all form fields", () => {
  const parameters = { From: "+14155550101", Body: "JOIN YES", MediaUrl: ["https://a", "https://b"] };
  const url = "https://api.example.test/api/telecom/sms/inbound?x=1";
  const signature = twilioSignature(settings.authToken, url, parameters);
  assert.equal(validTwilioSignature(settings.authToken, signature, url, parameters), true);
  assert.equal(validTwilioSignature(settings.authToken, signature, url + "/", parameters), false);
  assert.equal(validTwilioSignature(settings.authToken, signature, url, { ...parameters, Body: "JOIN" }), false);
  assert.equal(
    twilioSignature(settings.authToken, url, { ...parameters, MediaUrl: ["https://b", "https://a", "https://a"] }),
    signature,
  );
  assert.equal(publicWebhookUrl("https://api.example.test/", "/api/telecom/sms/inbound?x=1"), url);
});

test("Twilio Messaging sends form-encoded notifications and uses the approved-template fallback only for known trial rejections", async () => {
  const requests: Array<{ url: string; body: URLSearchParams }> = [];
  const responses = [
    new Response(JSON.stringify({ code: 21608, message: "trial recipient restriction" }), { status: 400 }),
    new Response(JSON.stringify({ sid: "SM" + "c".repeat(32), status: "queued" }), { status: 201 }),
  ];
  const adapter = new TwilioMessagingAdapter(async (url, init) => {
    requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    return responses.shift()!;
  }, settings);
  const result = await adapter.send({
    to: "447911123456",
    body: "You have received an email from A. Subject: Hello.",
    statusCallback: "https://api.example.test/api/telecom/messaging/status?deliveryId=1",
    templateVariables: { sender: "A", subject: "Hello" },
  });
  assert.deepEqual(result, { sid: "SM" + "c".repeat(32), status: "accepted" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.get("Body"), "You have received an email from A. Subject: Hello.");
  assert.equal(requests[0].body.get("To"), "+447911123456");
  assert.equal(requests[1].body.get("To"), "+447911123456");
  assert.equal(requests[0].body.has("ContentSid"), false);
  assert.equal(requests[1].body.get("ContentSid"), settings.approvedTemplateSid);
  assert.deepEqual(JSON.parse(requests[1].body.get("ContentVariables")!), { "1": "A", "2": "Hello" });
  assert.match(requests[0].url, /Accounts\/AC[a]{32}\/Messages\.json$/);
});

test("notification text strips controls and truncates without splitting Unicode code points", () => {
  const content = notificationBody("A\nSender", "Subject\u0000line");
  assert.equal(content, "You have received an email from A Sender. Subject: Subject line.");
  const large = notificationBody("A", "🙂".repeat(1000));
  assert.ok([...large].length <= 360);
  assert.ok(large.endsWith("…."));
});
