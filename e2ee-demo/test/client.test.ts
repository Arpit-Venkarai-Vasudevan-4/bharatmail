import assert from "node:assert/strict";
import test from "node:test";
import { simpleParser } from "mailparser";
import {
  createIdentity,
  createNativeProtectedKeyStore,
  decryptMime,
} from "@phonemail/e2ee-client";
import {
  E2eeClientError,
  PhoneMailE2eeClient,
  type CurrentPublicKey,
  type FingerprintTrustStore,
} from "@phonemail/e2ee-client/client";

const passphrase = "two-browser-context-test-passphrase";
const aliceId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";

class MemoryTrustStore implements FingerprintTrustStore {
  private readonly values = new Map<string, { userId: string; fingerprint: string }>();
  async get(userId: string) { return this.values.get(userId); }
  async set(value: { userId: string; fingerprint: string }) { this.values.set(value.userId, value); }
  async remove(userId: string) { this.values.delete(userId); }
}

test("typed client blocks untrusted/missing keys and sends ciphertext to real E2EE endpoint shape", { timeout: 60_000 }, async () => {
  const [alice, bob] = await Promise.all([
    createIdentity(aliceId, passphrase),
    createIdentity(bobId, passphrase),
  ]);
  const keys: Record<string, CurrentPublicKey> = {
    [aliceId]: {
      userId: aliceId, fingerprint: alice.fingerprint, encryptionKeyId: "",
      publicKey: alice.publicKey, createdAt: new Date().toISOString(),
    },
    [bobId]: {
      userId: bobId, fingerprint: bob.fingerprint, encryptionKeyId: "",
      publicKey: bob.publicKey, createdAt: new Date().toISOString(),
    },
  };
  const calls: { url: string; method: string; body: string }[] = [];
  let messageAttempts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, body });
    const userId = Object.keys(keys).find((id) => url.endsWith(`/api/e2ee/keys/${id}`));
    if (userId && method === "GET") return Response.json({ key: keys[userId] });
    if (url.endsWith("/api/e2ee/messages") && method === "POST") {
      messageAttempts += 1;
      return Response.json({
        message: { messageId: "message-id", conversationId: "conversation-id", duplicate: messageAttempts > 1 },
      }, { status: messageAttempts > 1 ? 200 : 201 });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } }, { status: 404 });
  };
  const trust = new MemoryTrustStore();
  const client = new PhoneMailE2eeClient({
    apiBaseUrl: "http://127.0.0.1:3351",
    accessToken: () => "disposable-token",
    trustStore: trust,
    fetcher,
  });
  const input = {
    sender: alice, passphrase, to: [bobId], subject: "must remain client-side",
    text: "private body", attachments: [new File(["attachment"], "private-name.txt")],
    idempotencyKey: "frontend-test-idempotency-key",
  };

  await assert.rejects(client.sendEncrypted(input), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "TRUST_REQUIRED");
  assert.ok(!calls.some((call) => call.url.endsWith("/api/e2ee/messages")));

  await trust.set({ userId: bobId, fingerprint: bob.fingerprint });
  const prepared = await client.prepareEncryptedMessage(input);
  await assert.rejects(client.sendPreparedMessage({ ...prepared }), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "REQUEST_REJECTED");
  const sent = await client.sendPreparedMessage(prepared);
  assert.equal(sent.message.messageId, "message-id");
  assert.equal((await client.sendPreparedMessage(prepared)).message.duplicate, true);
  const request = calls.find((call) => call.url.endsWith("/api/e2ee/messages"));
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.body.includes("must remain client-side"), false);
  assert.equal(request.body.includes("private body"), false);
  assert.equal(request.body.includes("private-name.txt"), false);
  const body = JSON.parse(request.body);
  assert.deepEqual(body.to, [bobId]);
  assert.deepEqual(body.cc, []);
  assert.deepEqual(body.keyFingerprints.sort(), [alice.fingerprint, bob.fingerprint].sort());
  assert.match(body.ciphertext, /^-----BEGIN PGP MESSAGE-----/);
  const messageRequests = calls.filter((call) => call.url.endsWith("/api/e2ee/messages"));
  assert.equal(messageRequests.length, 2);
  assert.equal(messageRequests[0].body, messageRequests[1].body, "an idempotent retry reuses exact ciphertext");
  const [decryptedMime, aliceSentMime] = await Promise.all([
    decryptMime(bob, passphrase, body.ciphertext, alice),
    decryptMime(alice, passphrase, body.ciphertext, alice),
  ]);
  assert.equal(aliceSentMime, decryptedMime, "the sender can decrypt the Sent copy");
  const parsed = await simpleParser(Buffer.from(decryptedMime));
  assert.equal(parsed.subject, input.subject);
  assert.equal(parsed.text, input.text);
  assert.equal(parsed.attachments[0].filename, "private-name.txt");
  assert.equal(parsed.attachments[0].content.toString(), "attachment");
});

test("encrypted draft save, revision update, send and idempotent retry use ciphertext-only requests", { timeout: 60_000 }, async () => {
  const [alice, bob] = await Promise.all([
    createIdentity(aliceId, passphrase),
    createIdentity(bobId, passphrase),
  ]);
  const keys: Record<string, CurrentPublicKey> = Object.fromEntries([alice, bob].map((identity) => [identity.userId, {
    userId: identity.userId,
    fingerprint: identity.fingerprint,
    encryptionKeyId: "",
    publicKey: identity.publicKey,
    createdAt: new Date().toISOString(),
  }]));
  const trust = new MemoryTrustStore();
  await trust.set({ userId: bobId, fingerprint: bob.fingerprint });
  const calls: { url: string; method: string; body: string }[] = [];
  let savedCiphertext = "";
  let revision = 1;
  let sendCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, method, body });
    const userId = Object.keys(keys).find((id) => url.endsWith(`/api/e2ee/keys/${id}`));
    if (userId && method === "GET") return Response.json({ key: keys[userId] });
    if (url.endsWith("/api/e2ee/drafts") && method === "POST") {
      savedCiphertext = JSON.parse(body).ciphertext;
      return Response.json({ draft: { id: "draft-id", revision } }, { status: 201 });
    }
    if (url.endsWith("/api/e2ee/drafts/draft-id") && method === "PUT") {
      const value = JSON.parse(body);
      savedCiphertext = value.ciphertext;
      revision += 1;
      return Response.json({ draft: { id: "draft-id", revision } });
    }
    if (url.endsWith("/api/e2ee/drafts/draft-id") && method === "GET") {
      return Response.json({ draft: { id: "draft-id", revision, ciphertext: savedCiphertext } });
    }
    if (url.endsWith("/api/e2ee/drafts/draft-id/send") && method === "POST") {
      sendCount += 1;
      return Response.json({ message: { messageId: "draft-message", duplicate: sendCount > 1 } }, { status: sendCount > 1 ? 200 : 201 });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } }, { status: 404 });
  };
  const client = new PhoneMailE2eeClient({
    apiBaseUrl: "http://127.0.0.1:3351",
    accessToken: () => "disposable-token",
    trustStore: trust,
    fetcher,
  });
  const oldContent = { subject: "draft subject secret", text: "first draft body" };
  const saved = await client.saveEncryptedDraft(alice, passphrase, oldContent);
  assert.equal(saved.draft.revision, 1);
  const updated = await client.updateEncryptedDraft(alice, passphrase, saved.draft.id, saved.draft.revision, {
    subject: "updated subject secret",
    text: "updated draft body",
    attachments: [new File(["secret attachment"], "private-draft.txt")],
  });
  assert.equal(updated.draft.revision, 2);
  const sendInput = {
    sender: alice,
    passphrase,
    to: [bobId],
    subject: "updated subject secret",
    text: "updated draft body",
    idempotencyKey: "draft-send-idempotency-key",
    draftId: saved.draft.id,
    revision: updated.draft.revision,
  };
  const prepared = await client.prepareEncryptedDraftSend(sendInput);
  assert.equal(prepared.revision, 2);
  await assert.rejects(client.sendPreparedDraft({ ...prepared }), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "REQUEST_REJECTED");
  const sent = await client.sendPreparedDraft(prepared);
  assert.equal(sent.message.messageId, "draft-message");
  assert.equal((await client.sendPreparedDraft(prepared)).message.duplicate, true);
  const apiBodies = calls.map((call) => call.body).filter(Boolean).join("\n");
  for (const secret of ["updated subject secret", "updated draft body", "private-draft.txt", "secret attachment"]) {
    assert.equal(apiBodies.includes(secret), false, `plaintext field ${secret} must never reach the API`);
  }
  const draftRequests = calls.filter((call) => call.url.endsWith("/api/e2ee/drafts"));
  assert.equal(draftRequests.length, 1);
  const sendRequests = calls.filter((call) => call.url.endsWith("/api/e2ee/drafts/draft-id/send"));
  assert.equal(sendRequests.length, 2);
  assert.equal(sendRequests[0].body, sendRequests[1].body);
});

test("QR verification distinguishes first use, changed keys and revoked keys", { timeout: 60_000 }, async () => {
  const identity = await createIdentity(aliceId, passphrase);
  let activeKey: CurrentPublicKey | undefined = {
    userId: aliceId,
    fingerprint: identity.fingerprint,
    encryptionKeyId: "",
    publicKey: identity.publicKey,
    createdAt: new Date().toISOString(),
  };
  const client = new PhoneMailE2eeClient({
    apiBaseUrl: "http://127.0.0.1:3351",
    accessToken: () => "disposable-token",
    trustStore: new MemoryTrustStore(),
    fetcher: async () => activeKey
      ? Response.json({ key: activeKey })
      : Response.json({ error: { code: "NOT_FOUND", message: "No active key" } }, { status: 404 }),
  });
  const { makeQrPayload } = await import("@phonemail/e2ee-client");
  const qr = await makeQrPayload(identity);
  const status = await client.inspectQr(qr);
  assert.equal(status.trust, "first-use-unverified");
  await assert.rejects(client.trustQr(status, false), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "TRUST_REQUIRED");

  const changed = await createIdentity(aliceId, passphrase);
  activeKey = { ...activeKey!, fingerprint: changed.fingerprint, publicKey: changed.publicKey };
  await assert.rejects(client.inspectQr(qr), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "KEY_CHANGED");
  activeKey = undefined;
  await assert.rejects(client.inspectQr(qr), (error: unknown) =>
    error instanceof E2eeClientError && error.code === "KEY_REVOKED");
});

test("native protected-key adapter persists only armored passphrase-protected keys", { timeout: 60_000 }, async () => {
  const identity = await createIdentity(aliceId, passphrase);
  const values = new Map<string, string>();
  const store = createNativeProtectedKeyStore({
    platform: "android",
    storage: "android-keystore",
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async deleteItem(key) { values.delete(key); },
  });
  await store.save(identity.userId, identity.encryptedPrivateKey);
  assert.equal(await store.load(identity.userId), identity.encryptedPrivateKey);
  await assert.rejects(store.save(identity.userId, identity.publicKey));
  await assert.rejects(Promise.resolve().then(() => createNativeProtectedKeyStore({
    platform: "android",
    storage: "apple-keychain",
    async getItem() { return null; },
    async setItem() {},
    async deleteItem() {},
  })));
});
