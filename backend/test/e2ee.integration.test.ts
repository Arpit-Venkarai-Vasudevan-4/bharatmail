import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as openpgp from "openpgp";
import test from "node:test";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const passphrase = "local-test-passphrase-long-enough";

async function request(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(10_000),
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message ?? "request failed"), { status: response.status, data });
  }
  return data;
}

async function rejected(path: string, init: RequestInit, token: string, status: number) {
  await assert.rejects(request(path, init, token), (error: any) => error.status === status);
}

async function register(phone: string) {
  return request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "secret123", termsAccepted: true }),
  });
}

async function reauthenticate(token: string) {
  await request("/api/e2ee/reauth", {
    method: "POST",
    body: JSON.stringify({ password: "secret123" }),
  }, token);
}

async function createKey(userId: string) {
  const pair = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ name: "PhoneMail test", email: `${userId}@keys.phonemail.com` }],
    passphrase,
    format: "armored",
  });
  const key = await openpgp.readKey({ armoredKey: pair.publicKey });
  return { ...pair, key, fingerprint: key.getFingerprint().toUpperCase() };
}

async function prove(privateKeyArmored: string, challenge: string) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: privateKeyArmored });
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  return openpgp.sign({
    message: await openpgp.createMessage({ text: challenge }),
    signingKeys: unlocked,
    detached: true,
    format: "armored",
  });
}

async function registerPublicKey(token: string, userId: string, key: Awaited<ReturnType<typeof createKey>>) {
  await reauthenticate(token);
  const issued = await request("/api/e2ee/key-challenges", {
    method: "POST",
    body: JSON.stringify({ action: "enroll" }),
  }, token);
  const proof = await prove(key.privateKey, issued.challenge.challenge);
  await request("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({
      action: "enroll",
      challengeId: issued.challenge.id,
      publicKey: key.publicKey,
      proof,
    }),
  }, token);
  const registered = await request(`/api/e2ee/keys/${userId}`, {}, token);
  assert.equal(registered.key.fingerprint, key.fingerprint);
  return registered.key;
}

async function encryptFor(
  signer: Awaited<ReturnType<typeof createKey>>,
  signerPrivateKey: string,
  recipients: Awaited<ReturnType<typeof createKey>>[],
  text: string,
) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: signerPrivateKey });
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  const message = await openpgp.createMessage({ text });
  const ciphertext = await openpgp.encrypt({
    message,
    encryptionKeys: recipients.map((recipient) => recipient.key),
    signingKeys: unlocked,
    format: "armored",
  });
  return { ciphertext, keyFingerprints: recipients.map((recipient) => recipient.fingerprint).sort() };
}

test("authenticated E2EE keys, opaque delivery, retries, drafts, rotation, revocation, and access isolation", { timeout: 60_000 }, async () => {
  const [alicePhone, bobPhone, carolPhone] = await Promise.all([randomTestPhone(), randomTestPhone(), randomTestPhone()]);
  const [alice, bob, carol] = await Promise.all([register(alicePhone), register(bobPhone), register(carolPhone)]);
  const aliceKey = await createKey(alice.user.id);
  const bobKey = await createKey(bob.user.id);
  const carolKey = await createKey(carol.user.id);
  await registerPublicKey(alice.token, alice.user.id, aliceKey);
  await registerPublicKey(bob.token, bob.user.id, bobKey);
  await rejected("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: alicePhone, password: "x".repeat(65 * 1024) }),
  }, "", 413);
  await rejected("/api/e2ee/drafts", {
    method: "POST",
    body: JSON.stringify({ ciphertext: "x".repeat(65 * 1024) }),
  }, alice.token, 400);

  await rejected("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "enroll" }),
  }, carol.token, 403);
  await reauthenticate(carol.token);
  const issued = await request("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "enroll" }),
  }, carol.token);
  const invalidProof = await prove(carolKey.privateKey, issued.challenge.challenge + "tampered");
  await rejected("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({ action: "enroll", challengeId: issued.challenge.id, publicKey: carolKey.publicKey, proof: invalidProof }),
  }, carol.token, 401);
  await rejected("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({ action: "enroll", challengeId: issued.challenge.id, publicKey: carolKey.publicKey, proof: await prove(carolKey.privateKey, issued.challenge.challenge) }),
  }, alice.token, 409);

  const secret = `opaque plaintext ${randomUUID()}`;
  const syncBefore = await request("/api/sync?limit=100", {}, bob.token);
  const encrypted = await encryptFor(aliceKey, aliceKey.privateKey, [aliceKey, bobKey], secret);
  const idempotencyKey = `e2ee-${randomUUID()}`;
  const requestBody = JSON.stringify({
    to: [bob.user.id],
    cc: [],
    ciphertext: encrypted.ciphertext,
    keyFingerprints: encrypted.keyFingerprints,
  });
  const sent = await request("/api/e2ee/messages", {
    method: "POST", body: requestBody, headers: { "Idempotency-Key": idempotencyKey },
  }, alice.token);
  const retried = await request("/api/e2ee/messages", {
    method: "POST", body: requestBody, headers: { "Idempotency-Key": idempotencyKey },
  }, alice.token);
  assert.equal(sent.message.messageId, retried.message.messageId);
  assert.equal(retried.message.duplicate, true);

  const bobMessage = await request(`/api/e2ee/messages/${sent.message.messageId}`, {}, bob.token);
  assert.equal(bobMessage.message.contentFormat, "openpgp-v1");
  assert.equal(bobMessage.message.ciphertext, encrypted.ciphertext);
  const conversation = await request(`/api/conversations/${sent.message.conversationId}`, {}, bob.token);
  const conversationMessage = conversation.messages.find((message: any) => message.id === sent.message.messageId);
  assert.equal(conversationMessage.contentFormat, "openpgp-v1");
  assert.equal(conversationMessage.subject, "Encrypted message");
  assert.equal(conversationMessage.body, "");
  const synced = await request(`/api/sync?cursor=${encodeURIComponent(syncBefore.cursor)}&limit=100`, {}, bob.token);
  assert.ok(synced.changes.some((change: any) => change.entity_id === sent.message.messageId && change.payload.contentFormat === "openpgp-v1"));
  assert.ok(!JSON.stringify(synced).includes(secret));
  await rejected(`/api/e2ee/messages/${sent.message.messageId}`, {}, carol.token, 404);
  const reply = await encryptFor(bobKey, bobKey.privateKey, [bobKey, aliceKey], `reply ${randomUUID()}`);
  const replyRequest = {
    to: [alice.user.id], cc: [], ciphertext: reply.ciphertext, keyFingerprints: reply.keyFingerprints,
    replyToId: sent.message.messageId,
  };
  const replySent = await request("/api/e2ee/messages", {
    method: "POST", body: JSON.stringify(replyRequest), headers: { "Idempotency-Key": `e2ee-${randomUUID()}` },
  }, bob.token);
  assert.equal(replySent.message.conversationId, sent.message.conversationId);
  await rejected("/api/e2ee/messages", {
    method: "POST",
    body: JSON.stringify({
      ...replyRequest,
      ciphertext: (await encryptFor(bobKey, bobKey.privateKey, [bobKey, aliceKey], "duplicate reply")).ciphertext,
    }),
    headers: { "Idempotency-Key": `e2ee-${randomUUID()}` },
  }, bob.token, 409);
  await rejected("/api/e2ee/messages", {
    method: "POST",
    body: JSON.stringify({
      to: [carol.user.id],
      ciphertext: encrypted.ciphertext,
      keyFingerprints: encrypted.keyFingerprints,
    }),
    headers: { "Idempotency-Key": `e2ee-${randomUUID()}` },
  }, alice.token, 409);

  const encryptedDraft = await encryptFor(aliceKey, aliceKey.privateKey, [aliceKey], "encrypted draft only");
  const draft = await request("/api/e2ee/drafts", {
    method: "POST", body: JSON.stringify({ ciphertext: encryptedDraft.ciphertext }),
  }, alice.token);
  await rejected(`/api/e2ee/drafts/${draft.draft.id}`, {}, bob.token, 404);
  const inboxCiphertext = await encryptFor(aliceKey, aliceKey.privateKey, [aliceKey, bobKey], "sent from encrypted draft");
  const draftSendKey = `e2ee-${randomUUID()}`;
  const draftBody = JSON.stringify({
    revision: draft.draft.revision,
    to: [bob.user.id],
    cc: [],
    keyFingerprints: inboxCiphertext.keyFingerprints,
    ciphertext: inboxCiphertext.ciphertext,
  });
  const draftSent = await request(`/api/e2ee/drafts/${draft.draft.id}/send`, {
    method: "POST", body: draftBody, headers: { "Idempotency-Key": draftSendKey },
  }, alice.token);
  const draftRetry = await request(`/api/e2ee/drafts/${draft.draft.id}/send`, {
    method: "POST", body: draftBody, headers: { "Idempotency-Key": draftSendKey },
  }, alice.token);
  assert.equal(draftSent.message.messageId, draftRetry.message.messageId);
  assert.equal(draftRetry.message.duplicate, true);

  const changedKey = await createKey(bob.user.id);
  await reauthenticate(bob.token);
  const challenge = await request("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "rotate" }),
  }, bob.token);
  const nextProof = await prove(changedKey.privateKey, challenge.challenge.challenge);
  const oldProof = await prove(bobKey.privateKey, challenge.challenge.challenge);
  await request("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({
      action: "rotate",
      challengeId: challenge.challenge.id,
      publicKey: changedKey.publicKey,
      proof: nextProof,
      previousProof: oldProof,
    }),
  }, bob.token);
  await rejected("/api/e2ee/messages", {
    method: "POST",
    body: JSON.stringify({
      to: [bob.user.id], ciphertext: encrypted.ciphertext, keyFingerprints: encrypted.keyFingerprints,
    }),
    headers: { "Idempotency-Key": `e2ee-${randomUUID()}` },
  }, alice.token, 409);

  const revokeChallenge = await request("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "revoke" }),
  }, bob.token);
  await request("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({
      action: "revoke",
      challengeId: revokeChallenge.challenge.id,
      proof: await prove(changedKey.privateKey, revokeChallenge.challenge.challenge),
    }),
  }, bob.token);
  await rejected(`/api/e2ee/keys/${bob.user.id}`, {}, bob.token, 404);

  const stored = await query<{ subject: string; body: string; ciphertext: string }>(
    `SELECT m.subject,m.body,e.ciphertext FROM messages m JOIN e2ee_messages e ON e.message_id=m.id
      WHERE m.id=$1`,
    [sent.message.messageId],
  );
  assert.equal(stored.rows[0].subject, "Encrypted message");
  assert.equal(stored.rows[0].body, "");
  assert.ok(!stored.rows[0].ciphertext.includes(secret));
  assert.ok(!JSON.stringify(bobMessage).includes(secret));
  assert.notEqual(
    createHash("sha256").update(stored.rows[0].ciphertext).digest("hex"),
    createHash("sha256").update(secret).digest("hex"),
  );
});
