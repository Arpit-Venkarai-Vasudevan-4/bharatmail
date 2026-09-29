import { api, setSessionState } from '../src/lib/api';
import { enqueueOperation, listOperations, processOperation } from '../src/lib/outbox';
import { AccountStore, setOfflineEnabled } from '../src/lib/storage';
const output = document.querySelector<HTMLPreElement>('#result')!;
const startButton = document.querySelector<HTMLButtonElement>('#start')!;
const resumeButton = document.querySelector<HTMLButtonElement>('#resume')!;
const cacheButton = document.querySelector<HTMLButtonElement>('#cache')!;
const checkpointKey = 'phonemail.integration-checkpoint';
type Checkpoint = { accountId: string; key: string; subject: string; started: string; passed: string[]; complete?: boolean };
let checkpoint: Checkpoint | undefined = JSON.parse(sessionStorage.getItem(checkpointKey) || 'null') || undefined;
function show(value: unknown) { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function disposableAccount() {
  assert(location.hostname === 'localhost' || location.hostname === '127.0.0.1', 'Only local development is allowed.');
  setSessionState('unknown');
  const { user } = await api<{ user: { id: string; displayName: string } }>('/auth/me');
  assert(/^Integration |acceptance/i.test(user.displayName), 'Sign in to a disposable integration account first.');
  setSessionState('authenticated'); return user;
}
function saveCheckpoint() { sessionStorage.setItem(checkpointKey, JSON.stringify(checkpoint)); }
async function run(work: () => Promise<void>) {
  startButton.disabled = resumeButton.disabled = cacheButton.disabled = true;
  try { await work(); } catch (e) { show('FAILED: ' + (e instanceof Error ? e.message : String(e))); }
  finally { startButton.disabled = false; resumeButton.disabled = !checkpoint || !!checkpoint.complete; cacheButton.disabled = false; }
}
startButton.onclick = () => void run(async () => {
  const user = await disposableAccount();
  const { contacts } = await api<{ contacts: { address: string }[] }>('/me/contacts');
  assert(contacts.length, 'This fixture needs a saved local test contact.');
  const subject = 'Browser recovery check ' + crypto.randomUUID();
  const { draft } = await api<{ draft: { id: string; revision: number } }>('/drafts', { method: 'POST', body: { to: [contacts[0].address], cc: [], subject, body: 'Disposable browser send-recovery check.' } });
  const operation = await enqueueOperation(user.id, { path: '/drafts/' + draft.id + '/send', body: {}, headers: { 'If-Match': '"revision-' + draft.revision + '"' }, draft });
  assert((await listOperations(user.id)).some(item => item.key === operation.key), 'Identity was not stored before sending.');
  const originalFetch = window.fetch; let dropped = false;
  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    if (!dropped && input === '/api/drafts/' + draft.id + '/send' && init?.method === 'POST') {
      assert(response.ok, 'Server did not commit the test send.');
      dropped = true; await response.arrayBuffer(); throw new TypeError('Test response loss after server commitment');
    }
    return response;
  };
  try {
    const result = await processOperation(user.id, operation.key);
    assert(dropped && result.state === 'unknown', 'Response loss must leave an unknown, recoverable operation.');
  } finally { window.fetch = originalFetch; }
  checkpoint = { accountId: user.id, key: operation.key, subject, started: new Date().toISOString(), passed: ['Real IndexedDB operation identity saved before send', 'Real server commitment with deliberately lost response', 'Unknown outcome retained without creating another key'] };
  saveCheckpoint(); show({ ...checkpoint, next: 'Reload this page, then select Resume after reload.' });
});
resumeButton.onclick = () => void run(async () => {
  assert(checkpoint, 'No response-loss checkpoint found.'); const user = await disposableAccount();
  assert(checkpoint.accountId === user.id, 'Account changed; the original account must reconcile its own send.');
  const saved = (await listOperations(user.id)).find(item => item.key === checkpoint!.key);
  assert(saved?.state === 'unknown', 'Unknown operation must survive page reload.');
  const result = await processOperation(user.id, checkpoint.key); assert(result.state === 'sent', 'Committed operation was not reconciled.');
  const again = await processOperation(user.id, checkpoint.key); assert(again.resourceId === result.resourceId, 'Confirmed retry changed the resource identity.');
  const mailbox = await api<{ messages: { subject: string }[] }>('/conversations/mailbox/sent?limit=100');
  assert(mailbox.messages.filter(m => m.subject === checkpoint!.subject).length === 1, 'Expected exactly one committed message.');
  checkpoint.passed.push('Unknown operation survives real page reload', 'Operation lookup reconciles commitment before replay', 'Repeat check retains one message in Sent');
  checkpoint.complete = true; saveCheckpoint(); show(checkpoint);
});
cacheButton.onclick = () => void run(async () => {
  const accountId = crypto.randomUUID(), otherId = crypto.randomUUID();
  await setOfflineEnabled(accountId, true); const cache = new AccountStore(accountId);
  try {
    await cache.batch([{ bucket: 'local-draft', key: 'mine', value: { body: 'unsent fixture' } }, { bucket: 'server:message', key: 'remote', value: { subject: 'fixture' } }, { bucket: 'sync', key: 'state', value: { cursor: '9007199254740999' } }]);
    assert(await new AccountStore(accountId).get('local-draft', 'mine'), 'A new store must read durable work.');
    assert(!(await new AccountStore(otherId).get('local-draft', 'mine')), 'Cache must be isolated by account.');
    let rejected = false;
    try { await cache.batch([{ bucket: 'local-draft', key: 'too-big', value: 'x'.repeat(6 * 1024 * 1024) }, { bucket: 'sync', key: 'state', value: { cursor: '9007199254741000' } }]); } catch { rejected = true; }
    assert(rejected, 'Oversize transaction should fail.');
    assert((await cache.get<{ cursor: string }>('sync', 'state'))?.cursor === '9007199254740999', 'Failed storage must not advance the cursor.');
    await cache.batch([{ bucket: 'server:message', key: 'remote', delete: true }, { bucket: 'sync', key: 'state', value: { cursor: '9007199254741000' } }]);
    assert(!(await cache.get('server:message', 'remote')), 'Tombstone must remove the server record.');
    assert(await cache.get('local-draft', 'mine'), 'Tombstone must preserve unsent work.');
    show({ passed: ['Real browser IndexedDB durability', 'Immutable account storage isolation', 'Oversize transaction rolls back record and BIGINT cursor', 'Atomic tombstone and cursor advance preserve unsent drafts'] });
  } finally { await setOfflineEnabled(accountId, false); }
});
if (checkpoint) { resumeButton.disabled = !!checkpoint.complete; show({ ...checkpoint, reloaded: true }); }
