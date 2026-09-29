/** Exercises the shipped upload and encryption modules against real local API responses. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { register, base } from './live-support.mjs';
import { uploadFile } from '../src/lib/uploads';
import { PhoneMailE2eeClient, type FingerprintTrustStore, type StoredTrust } from '../src/vendor/e2ee/client';
import { createIdentity, decryptMime, makeQrPayload, importIdentity, exportIdentity } from '../src/vendor/e2ee';
import { decodeMime } from '../src/features/security/mime';
import { syncAccount } from '../src/lib/sync';
import { accountStore } from '../src/lib/storage';
import { portalApi } from '../src/lib/api';
class Pins implements FingerprintTrustStore {
  values = new Map<string, StoredTrust[]>();
  async get(id: string) { return this.values.get(id)?.at(-1); }
  async getHistory(id: string) { return this.values.get(id) || []; }
  async set(pin: StoredTrust) { this.values.set(pin.userId, [...(this.values.get(pin.userId) || []), pin]); }
  async remove(id: string) { this.values.delete(id); }
}
const passed: string[] = [], timings: Record<string, number> = {}, accounts: Awaited<ReturnType<typeof register>>[] = [];
const started = new Date().toISOString(), nativeFetch = globalThis.fetch;
try {
  const alice = await register('Frontend module acceptance'), bob = await register('Encryption recipient'); accounts.push(alice, bob);
  let loseResponse = true, reconciliations = 0;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/api/')) return nativeFetch(input, init);
    if (init?.credentials === 'omit') {
      assert.equal(new Headers(init.headers).has('X-Auth-Transport'), false);
      assert.equal(new Headers(init.headers).has('Cookie'), false);
      return nativeFetch(base + input, init);
    }
    const response = await alice.client.response(input, init);
    if (input.endsWith('/status')) reconciliations++;
    if (loseResponse && init?.method === 'PATCH' && input.startsWith('/api/uploads/')) {
      loseResponse = false; await response.arrayBuffer(); throw new TypeError('Injected response loss after real chunk commitment');
    }
    return response;
  };
  const bytes = new Uint8Array(1024 * 1024 + 77); bytes.fill(42); bytes[bytes.length - 1] = 255;
  const file = new File([bytes], 'unicode-नमस्ते.bin', { type: 'application/octet-stream' });
  let uploadId = '';
  const upload = await uploadFile(file, { onUploadId: id => { uploadId = id; } });
  assert.equal(upload.id, uploadId); assert.equal(upload.offset, bytes.length); assert.equal(reconciliations, 1);
  assert.deepEqual(new Uint8Array(await (await alice.client.response('/api/uploads/' + upload.id)).arrayBuffer()), bytes);
  const resumedReady = await uploadFile(file, { uploadId }); assert.equal(resumedReady.id, uploadId);
  passed.push('Real frontend upload: lost committed chunk response reconciles offset; exact bytes; ready upload reuse');
  const controller = new AbortController(); let interruptedId = '';
  await assert.rejects(uploadFile(file, { signal: controller.signal, onUploadId: id => { interruptedId = id; }, onProgress: p => { if (p > 0) controller.abort(); } }));
  assert.ok(interruptedId); assert.equal((await uploadFile(file, { uploadId: interruptedId })).offset, bytes.length);
  passed.push('Frontend upload cancellation and explicit retry resume the existing server upload');
  const portal = await portalApi<{ token: string }>('/auth/register', { method: 'POST', body: { phone: '+1415555' + String(randomInt(0, 10000)).padStart(4, '0'), country: 'US', password: 'Portal-' + randomUUID(), signupChannel: 'portal', termsAccepted: true, termsVersion: 'mvp-1' } });
  assert.ok(portal.token);
  await portalApi('/auth/logout', { method: 'POST' }, portal.token);
  assert.equal((await alice.client.request('/api/auth/me')).user.id, alice.user.id);
  passed.push('Real portal module uses credentials:omit for register/logout and leaves the main cookie session intact');
  // Node's Web Locks API, where available, uses the same request contract as the browser.
  if (navigator.locks) {
    const cache = accountStore(alice.user.id); await cache.put('local-draft', 'preserved-local', { text: 'Unsynced local work' });
    let synced = await syncAccount(alice.user.id, new AbortController().signal);
    while (synced.more) synced = await syncAccount(alice.user.id, new AbortController().signal);
    assert.ok(await cache.get('server:account', alice.user.id));
    const previous = await cache.get<{ cursor: string }>('sync', 'state'); assert.equal(typeof previous?.cursor, 'string');
    await alice.client.request('/api/me/preferences', { method: 'PATCH', body: { readReceipts: false } });
    await syncAccount(alice.user.id, new AbortController().signal);
    const next = await cache.get<{ cursor: string }>('sync', 'state'); assert.ok(BigInt(next!.cursor) > BigInt(previous!.cursor));
    assert.ok(await cache.get('local-draft', 'preserved-local'));
    passed.push('Frontend sync applies live snapshot and incremental revision strings without deleting local drafts (memory cache)');
  }
  globalThis.fetch = nativeFetch;
  function client(account: typeof alice, pins = new Pins()) {
    return new PhoneMailE2eeClient({ apiBaseUrl: base, trustStore: pins, request: async <T>(path: string, input: { method?: string; body?: unknown; idempotencyKey?: string } = {}) => account.client.request(path, { method: input.method, body: input.body, headers: input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : undefined }) as Promise<T> });
  }
  const aPins = new Pins(), bPins = new Pins(), a = client(alice, aPins), b = client(bob, bPins);
  const secret = 'Local acceptance passphrase ' + randomUUID();
  const start = performance.now(); const aKey = await createIdentity(alice.user.id, secret), bKey = await createIdentity(bob.user.id, secret);
  await a.enroll(aKey, secret, alice.password); await b.enroll(bKey, secret, bob.password);
  timings.twoKeyCreationAndEnrollmentMs = Math.round(performance.now() - start);
  passed.push('Two cookie-authenticated identities enroll using password reauthentication and signed challenges');
  const aQr = await makeQrPayload(aKey), bQr = await makeQrPayload(bKey);
  const inspected = await a.inspectQr(bQr); assert.equal(inspected.identity.fingerprint, bKey.fingerprint);
  await assert.rejects(a.trustQr(inspected, false)); await a.trustQr(inspected, true); await b.trustQr(await b.inspectQr(aQr), true);
  passed.push('Live key lookup, full fingerprint match, explicit independent trust consent');
  const input = { sender: aKey, passphrase: secret, to: [bob.user.id], subject: 'Encrypted subject', text: 'नमस्ते\nPrivate live content', attachments: [new File([new Uint8Array([0, 7, 255])], 'private.bin', { type: 'application/octet-stream' })], idempotencyKey: randomUUID() };
  const prepared = await a.prepareEncryptedMessage(input); const durable = await a.exportPrepared(prepared, aKey, secret);
  const sent = (await a.sendPreparedMessage(prepared)).message;
  for (const [c, identity] of [[a, aKey], [b, bKey]] as const) {
    const mail = decodeMime(await c.decryptMessage(identity, secret, sent.messageId));
    assert.equal(mail.subject, input.subject); assert.equal(mail.text, input.text); assert.deepEqual([...mail.attachments[0].bytes], [0, 7, 255]);
  }
  passed.push('Encrypted message and file: recipient signature verification and sender Sent decryption');
  const fresh = client(alice, aPins); const restored = await fresh.restorePrepared(JSON.parse(JSON.stringify(durable)), aKey);
  const retried = (await fresh.sendPreparedMessage(restored)).message;
  assert.equal(retried.messageId, sent.messageId); assert.equal(retried.duplicate, true);
  const lookup = await alice.client.request('/api/conversations/operations/' + prepared.idempotencyKey); assert.equal(lookup.operation.resourceId, sent.messageId);
  passed.push('Signed durable operation restored in a new client: exact ciphertext retry commits once');
  const reply = (await b.sendEncrypted({ sender: bKey, passphrase: secret, to: [alice.user.id], subject: 'Encrypted reply', text: 'One encrypted reply', replyToId: sent.messageId, idempotencyKey: randomUUID() })).message;
  assert.equal(reply.conversationId, sent.conversationId);
  assert.equal(decodeMime(await a.decryptMessage(aKey, secret, reply.messageId)).text, 'One encrypted reply');
  await assert.rejects(b.sendEncrypted({ sender: bKey, passphrase: secret, to: [alice.user.id], subject: 'Duplicate', text: 'Blocked second reply', replyToId: sent.messageId, idempotencyKey: randomUUID() }));
  passed.push('Encrypted reply retains thread; duplicate reply is rejected');
  const draft = (await a.saveEncryptedDraft(aKey, secret, { subject: 'Secret draft', text: 'Version one', draftRouting: { to: [bob.user.id], cc: [] } })).draft;
  const updated = (await a.updateEncryptedDraft(aKey, secret, draft.id, draft.revision, { subject: 'Secret draft', text: 'Version two', draftRouting: { to: [bob.user.id], cc: [] } })).draft;
  await assert.rejects(a.updateEncryptedDraft(aKey, secret, draft.id, draft.revision, { subject: 'Stale', text: 'Must reject' }));
  const raw = await alice.client.request('/api/e2ee/drafts/' + draft.id);
  const decoded = decodeMime(await decryptMime(aKey, secret, raw.draft.ciphertext)); assert.deepEqual(decoded.to, [bob.user.id]);
  const draftSend = await a.prepareEncryptedDraftSend({ ...input, draftId: draft.id, revision: updated.revision, idempotencyKey: randomUUID() });
  const draftSent = (await a.sendPreparedDraft(draftSend)).message;
  assert.equal(decodeMime(await b.decryptMessage(bKey, secret, draftSent.messageId)).text, 'Version two');
  passed.push('Encrypted drafts: revision conflict, recipient restoration, atomic send of saved content');
  const imported = await importIdentity(alice.user.id, await exportIdentity(aKey), secret); assert.equal(imported.fingerprint, aKey.fingerprint);
  const next = await createIdentity(alice.user.id, secret); await a.rotate(aKey, next, secret, alice.password);
  await assert.rejects(b.inspectQr(aQr)); await b.trustQr(await b.inspectQr(await makeQrPayload(next)), true);
  assert.equal(decodeMime(await b.decryptMessage(bKey, secret, sent.messageId)).text, input.text);
  assert.equal(decodeMime(await a.decryptMessage(aKey, secret, sent.messageId)).text, input.text);
  passed.push('Protected backup import and key rotation retain historical verified mail and sender Sent access');
  await a.revoke(next, secret, alice.password); await assert.rejects(b.inspectQr(await makeQrPayload(next)));
  passed.push('Signed revocation blocks revoked identity QR');
  const report = { started, finished: new Date().toISOString(), api: base, runtime: process.version, passed, timings, limitations: ['Live local API, no real provider delivery.', 'Durable crypto restoration uses a new client instance, not a browser reload.', 'Camera and QR image decoding need separate browser checks.'] };
  await writeFile('docs/frontend-live-results.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: passed.length, checks: passed, timings }, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
  for (const account of accounts) await account.client.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
}
