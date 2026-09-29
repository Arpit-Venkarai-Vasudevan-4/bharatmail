import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { parsePhoneNumberWithError } from "libphonenumber-js/min";

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  argumentsByName.set(process.argv[index], process.argv[index + 1]);
}
const api = argumentsByName.get("--api") ?? "http://127.0.0.1:3361";
const inboundHost = argumentsByName.get("--inbound-host") ?? "127.0.0.1";
const inboundPort = Number(argumentsByName.get("--inbound-port") ?? "3364");
const mailpit = argumentsByName.get("--mailpit") ?? "http://127.0.0.1:3362";
const unique = randomUUID().slice(0, 8);
const password = "SmtpDemo!local123";
const allocatedPhones = new Set();

function fetchBounded(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
}

async function request(path, { token, ...init } = {}) {
  const response = await fetchBounded(`${api}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw Object.assign(
      new Error(`${init.method ?? "GET"} ${path} failed (${response.status}): ${value?.error?.code ?? "HTTP_ERROR"}`),
      { status: response.status, code: value?.error?.code },
    );
  }
  return value;
}

async function register(index) {
  let lastError;
  let collisions = 0;
  for (let offset = 0; offset < 10_000 && collisions < 250; offset += 1) {
    const candidate = `+447911${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
    let parsedPhone;
    try {
      parsedPhone = parsePhoneNumberWithError(candidate);
    } catch {
      continue;
    }
    if (!parsedPhone.isValid() || parsedPhone.country !== "GB") continue;
    if (allocatedPhones.has(candidate)) continue;
    allocatedPhones.add(candidate);
    try {
      const response = await request("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          phone: candidate,
          country: "GB",
          password,
          displayName: `SMTP Demo ${unique}-${index}`,
          language: "en",
          termsAccepted: true,
          signupChannel: "web",
        }),
      });
      return { ...response, phone: candidate };
    } catch (error) {
      lastError = error;
      if (!error || error.status !== 409 || error.code !== "CONFLICT") {
        throw error;
      }
      collisions += 1;
    }
  }
  throw lastError ?? new Error("No available test phone could be allocated for the SMTP demo");
}

async function waitForMailpit(subject) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const response = await fetchBounded(`${mailpit}/api/v1/messages?start=0&limit=50`);
    if (response.ok) {
      const listing = await response.json();
      const rows = listing.messages ?? listing.Messages ?? [];
      for (const row of rows) {
        const id = row.ID ?? row.id;
        if (!id) continue;
        const detailResponse = await fetchBounded(`${mailpit}/api/v1/message/${encodeURIComponent(id)}`);
        if (!detailResponse.ok) continue;
        const detail = await detailResponse.json();
        if ((detail.Subject ?? detail.subject) === subject) return { id, detail };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Mailpit did not capture subject ${subject}`);
}

function mailpitHeaderValues(headers, targetName) {
  const source = headers.Headers ?? headers.headers ?? headers;
  const entry = Object.entries(source).find(([name]) => name.toLowerCase() === targetName.toLowerCase());
  if (!entry) return [];
  const values = Array.isArray(entry[1]) ? entry[1] : [entry[1]];
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return String(value.Value ?? value.value ?? value.Text ?? value.text ?? "");
    return "";
  }).filter(Boolean);
}

async function capturedHeaders(messageId) {
  const response = await fetchBounded(`${mailpit}/api/v1/message/${encodeURIComponent(messageId)}/headers`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForDeliveryStates(token, conversationId, messageId, expected) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const result = await request(`/api/conversations/${conversationId}/messages/${messageId}/delivery`, { token });
    const recipients = result.delivery.recipients;
    if (expected.every(({ email, status }) =>
      recipients.some((recipient) => recipient.email.toLowerCase() === email.toLowerCase() && recipient.status === status))) {
      return recipients;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Outbox delivery did not reach expected states for message ${messageId}`);
}

async function readIncrementalChanges(token, cursor) {
  const changes = [];
  for (let page = 0; page < 20; page += 1) {
    const result = await request(`/api/sync?cursor=${encodeURIComponent(cursor)}&limit=100`, { token });
    changes.push(...result.changes);
    cursor = result.cursor;
    if (!result.hasMore) return { changes, cursor };
  }
  throw new Error("Incremental sync exceeded its bounded page count");
}

async function deliverIncoming(to, messageId) {
  const client = nodemailer.createTransport({
    host: inboundHost,
    port: inboundPort,
    secure: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    return await client.sendMail({
      from: "external-sender@example.test",
      to,
      subject: `Incoming ${unique} – résumé`,
      messageId,
      date: new Date("2025-01-01T00:00:00.000Z"),
      text: `Incoming body ${unique}`,
      html: `<script>throw new Error("must not execute")</script><p>Incoming body ${unique}</p>`,
      attachments: [{ filename: "../../demo-attachment.txt", content: Buffer.from(`attachment-${unique}`) }],
    });
  } finally {
    client.close();
  }
}

async function rejectsSmtpRecipient(address) {
  const client = nodemailer.createTransport({
    host: inboundHost,
    port: inboundPort,
    secure: false,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10_000,
  });
  try {
    await assert.rejects(client.sendMail({
      from: "external-sender@example.test",
      to: address,
      text: "must be rejected before acceptance",
    }), (error) => error.responseCode === 550);
  } finally {
    client.close();
  }
}

const sender = await register(1);
const localRecipient = await register(2);
const senderEmail = sender.user.email;
const recipientEmail = localRecipient.user.email;
assert.ok(senderEmail.endsWith("@phonemail.test"));
assert.ok(recipientEmail.endsWith("@phonemail.test"));

await assert.rejects(request("/api/mail/compose", {
  method: "POST",
  body: JSON.stringify({ to: ["person@example.test"], body: "unauthorized" }),
}), (error) => error.status === 401);

const localConversation = await request("/api/conversations", {
  method: "POST",
  token: sender.token,
  body: JSON.stringify({ participantPhones: [localRecipient.phone], country: "US" }),
});
const localSent = await request(`/api/conversations/${localConversation.conversation.id}/messages`, {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `local-send-${unique}` },
  body: JSON.stringify({ subject: `Internal ${unique}`, body: "PhoneMail local delivery" }),
});
const localRetry = await request(`/api/conversations/${localConversation.conversation.id}/messages`, {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `local-send-${unique}` },
  body: JSON.stringify({ subject: `Internal ${unique}`, body: "PhoneMail local delivery" }),
});
assert.equal(localRetry.message.id, localSent.message.id);
const localInbox = await request("/api/conversations/mailbox/inbox", { token: localRecipient.token });
assert.ok(localInbox.messages.some((message) => message.id === localSent.message.id));
console.log("PASS internal PhoneMail delivery");

const externalSubject = `External ${unique} – नमस्ते`;
const externalBody = `Unicode body: नमस्ते 🌻 ${unique}`;
const externalTo = `capture-${unique}@example.test`;
const externalCc = `copy-${unique}@example.test`;
const outgoing = await request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-compose-${unique}` },
  body: JSON.stringify({
    to: [externalTo],
    cc: [externalCc, recipientEmail],
    subject: externalSubject,
    body: externalBody,
  }),
});
assert.equal(outgoing.delivery.status, "smtp_queued");
const outgoingRetry = await request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-compose-${unique}` },
  body: JSON.stringify({
    to: [externalTo],
    cc: [externalCc, recipientEmail],
    subject: externalSubject,
    body: externalBody,
  }),
});
assert.equal(outgoingRetry.message.id, outgoing.message.id);
await assert.rejects(request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-compose-${unique}` },
  body: JSON.stringify({ to: ["somebody@example.test"], subject: "spoof", body: "same key, different request" }),
}), (error) => error.status === 409);
await assert.rejects(request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-forged-${unique}` },
  body: JSON.stringify({ from: "foreign@example.test", to: ["somebody@example.test"], body: "spoof" }),
}), (error) => error.status === 400);
await assert.rejects(request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-local-${unique}` },
  body: JSON.stringify({ to: [`unknown@phonemail.test`], body: "local bypass" }),
}), (error) => error.status === 409);
await assert.rejects(request("/api/mail/compose", {
  method: "POST",
  token: sender.token,
  headers: { "Idempotency-Key": `smtp-header-${unique}` },
  body: JSON.stringify({ to: ["somebody@example.test"], subject: "bad\r\nBcc: victim@example.test", body: "injection" }),
}), (error) => error.status === 400);
const capturedOutgoing = await waitForMailpit(externalSubject);
const outgoingHeaders = await capturedHeaders(capturedOutgoing.id);
assert.ok(mailpitHeaderValues(outgoingHeaders, "To").some((value) => value.toLowerCase().includes(externalTo)));
assert.ok(mailpitHeaderValues(outgoingHeaders, "Cc").some((value) =>
  value.toLowerCase().includes(externalCc) && value.toLowerCase().includes(recipientEmail.toLowerCase())));
assert.ok(mailpitHeaderValues(outgoingHeaders, "Message-ID").some((value) => value.includes(`<${outgoing.message.id}@phonemail.test>`)));
const mixedDelivery = await waitForDeliveryStates(sender.token, outgoing.message.conversationId, outgoing.message.id, [
  { email: externalTo, status: "relay_accepted" },
  { email: externalCc, status: "relay_accepted" },
  { email: recipientEmail, status: "local_committed" },
]);
assert.equal(mixedDelivery.filter((recipient) => recipient.email.toLowerCase() === recipientEmail.toLowerCase()).length, 1,
  "mixed delivery must create one local mailbox entry");
const mixedInbox = await request("/api/conversations/mailbox/inbox", { token: localRecipient.token });
assert.equal(mixedInbox.messages.filter((message) => message.id === outgoing.message.id).length, 1);
const outgoingListing = await fetchBounded(`${mailpit}/api/v1/messages?start=0&limit=50`).then((response) => response.json());
assert.equal((outgoingListing.messages ?? outgoingListing.Messages ?? [])
  .filter((row) => (row.Subject ?? row.subject) === externalSubject).length, 1,
  "same idempotency key must not create a second SMTP submission");
console.log(`PASS outbound SMTP captured by Mailpit (${capturedOutgoing.id})`);

const draftTo = `draft-${unique}@example.test`;
const draftCc = `draft-copy-${unique}@example.test`;
const messagesBeforeDraftSave = await fetchBounded(`${mailpit}/api/v1/messages?start=0&limit=50`)
  .then((r) => r.ok ? r.json() : Promise.reject(new Error("Mailpit message listing failed")));
const mailCountBeforeDraftSave = (messagesBeforeDraftSave.messages ?? messagesBeforeDraftSave.Messages ?? []).length;
const draft = await request("/api/drafts", {
  method: "POST",
  token: sender.token,
  body: JSON.stringify({ to: [draftTo], cc: [draftCc], subject: `Saved draft ${unique}`, body: `Draft was sent ${unique}` }),
});
const messagesAfterDraftSave = await fetchBounded(`${mailpit}/api/v1/messages?start=0&limit=50`)
  .then((r) => r.ok ? r.json() : Promise.reject(new Error("Mailpit message listing failed")));
assert.equal((messagesAfterDraftSave.messages ?? messagesAfterDraftSave.Messages ?? []).length, mailCountBeforeDraftSave,
  "saving a first draft must not submit an SMTP message");
const sentDraft = await request(`/api/drafts/${draft.draft.id}/send`, {
  method: "POST",
  token: sender.token,
  headers: {
    "If-Match": `"revision-${draft.draft.revision}"`,
    "Idempotency-Key": `smtp-send-draft-${unique}`,
  },
  body: JSON.stringify({}),
});
assert.ok(sentDraft.message.id);
const sentDraftRetry = await request(`/api/drafts/${draft.draft.id}/send`, {
  method: "POST",
  token: sender.token,
  headers: {
  "If-Match": `"revision-${draft.draft.revision}"`,
  "Idempotency-Key": `smtp-send-draft-${unique}`,
  },
  body: JSON.stringify({}),
});
assert.equal(sentDraftRetry.message.id, sentDraft.message.id);
assert.equal(sentDraft.message.subject, `Saved draft ${unique}`);
await waitForMailpit(`Saved draft ${unique}`);
const messagesAfterDraftSend = await fetchBounded(`${mailpit}/api/v1/messages?start=0&limit=50`)
  .then((r) => r.ok ? r.json() : Promise.reject(new Error("Mailpit message listing failed")));
assert.equal((messagesAfterDraftSend.messages ?? messagesAfterDraftSend.Messages ?? []).length, mailCountBeforeDraftSave + 1,
  "sending the saved draft and retrying must produce one SMTP submission");
console.log("PASS external To/CC saved draft send");

const syncBaseline = await readIncrementalChanges(localRecipient.token, "0");
const incomingId = `<incoming-${unique}@example.test>`;
await deliverIncoming(recipientEmail, incomingId);
await deliverIncoming(recipientEmail, incomingId);
await rejectsSmtpRecipient(`not-a-user@phonemail.test`);
await rejectsSmtpRecipient("relay-out@example.net");
const inbox = await request("/api/conversations/mailbox/inbox", { token: localRecipient.token });
const received = inbox.messages.find((message) => message.subject === `Incoming ${unique} – résumé`);
assert.ok(received, "incoming SMTP message must appear in the existing inbox");
assert.equal(inbox.messages.filter((message) => message.subject === `Incoming ${unique} – résumé`).length, 1, "duplicate SMTP retry must be deduplicated");
assert.equal(received.isRead, false, "incoming SMTP message must be unread");
const conversation = await request(`/api/conversations/${received.conversationId}`, { token: localRecipient.token });
const incoming = conversation.messages.find((message) => message.id === received.id);
assert.equal(incoming.body, `Incoming body ${unique}`);
assert.ok(incoming.attachments.length === 1);
assert.equal(incoming.attachments[0].filename, "demo-attachment.txt");
const downloaded = await fetchBounded(`${api}/api/uploads/${incoming.attachments[0].id}`, {
  headers: { authorization: `Bearer ${localRecipient.token}` },
});
assert.equal(downloaded.status, 200);
assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), `attachment-${unique}`);
const unauthorizedDownload = await fetchBounded(`${api}/api/uploads/${incoming.attachments[0].id}`, {
  headers: { authorization: `Bearer ${sender.token}` },
});
assert.equal(unauthorizedDownload.status, 404);
const search = await request(`/api/search/messages?q=${encodeURIComponent(unique)}&limit=10`, { token: localRecipient.token });
assert.ok(search.messages.some((message) => message.id === received.id));
const incrementalSync = await readIncrementalChanges(localRecipient.token, syncBaseline.cursor);
assert.equal(incrementalSync.changes.filter((change) => change.entity_type === "message" && change.entity_id === received.id).length, 1,
  "new inbound SMTP mail must appear once in incremental sync");
const snapshot = await request("/api/sync/snapshot?limit=100", { token: localRecipient.token });
assert.ok(JSON.stringify(snapshot.records).includes(received.id), "incoming SMTP message must appear in the current-state sync snapshot");
console.log("PASS inbound SMTP mailbox, unread, search, attachment authorization, and snapshot sync");

const reply = await request("/api/mail/reply", {
  method: "POST",
  token: localRecipient.token,
  headers: { "Idempotency-Key": `smtp-reply-${unique}` },
  body: JSON.stringify({ conversationId: received.conversationId, messageId: received.id, body: `Reply ${unique}` }),
});
assert.equal(reply.delivery.status, "smtp_queued");
const replyRetry = await request("/api/mail/reply", {
  method: "POST",
  token: localRecipient.token,
  headers: { "Idempotency-Key": `smtp-reply-${unique}` },
  body: JSON.stringify({ conversationId: received.conversationId, messageId: received.id, body: `Reply ${unique}` }),
});
assert.equal(replyRetry.message.id, reply.message.id);
await assert.rejects(request("/api/mail/reply", {
  method: "POST",
  token: localRecipient.token,
  headers: { "Idempotency-Key": `smtp-second-reply-${unique}` },
  body: JSON.stringify({ conversationId: received.conversationId, messageId: received.id, body: "second reply" }),
}), (error) => error.status === 409);
const capturedReply = await waitForMailpit(reply.message.subject);
const replyHeadersResponse = await fetchBounded(`${mailpit}/api/v1/message/${encodeURIComponent(capturedReply.id)}/headers`);
assert.equal(replyHeadersResponse.status, 200);
const replyHeaders = await replyHeadersResponse.json();
assert.ok(mailpitHeaderValues(replyHeaders, "In-Reply-To").some((value) => value.includes(incomingId)));
assert.ok(mailpitHeaderValues(replyHeaders, "References").some((value) => value.includes(incomingId)));
console.log("PASS application reply delivered with incoming Message-ID threading");

const capabilities = await request("/api/capabilities");
assert.equal(capabilities.integrations.mailTransport.mode, "smtp");
assert.equal(capabilities.integrations.mailTransport.listenerAvailable, true);
console.log(`API readiness: ${api}/ready`);
console.log(`Mailpit captured mail: ${mailpit}`);
