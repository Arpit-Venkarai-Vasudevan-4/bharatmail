import {t} from '../i18n';
import { api, ApiError, withBrowserLock } from './api';

export type Operation = {
  key: string; accountId: string; path: string; body?: Record<string, unknown>; headers?: Record<string, string>;
  draft?: { id: string; revision: number }; createdAt: number; attempts: number; retryAt?: number;
  state: 'queued' | 'unknown' | 'sent' | 'failed' | 'expired'; error?: string;
  resourceId?: string;
};
const DB = 'phonemail-send-ledger-v1';
const updates = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('phonemail.outbox.v1') : null;
updates?.addEventListener('message', () => window.dispatchEvent(new Event('phonemail:outbox')));
function notify() { window.dispatchEvent(new Event('phonemail:outbox')); updates?.postMessage({ type: 'changed' }); }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('operations', { keyPath: ['accountId', 'key'] });
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => reject(new Error(t("m_621dbe614022")));
  });
}
async function records<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('operations', mode); const request = action(tx.objectStore('operations'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error(t("m_583719c35b27")));
    });
  } finally { db.close(); }
}
async function save(operation: Operation) { await records('readwrite', store => store.put(operation)); notify(); }
export async function listOperations(userId: string): Promise<Operation[]> {
  const values = await records<Operation[]>('readonly', store => store.getAll(IDBKeyRange.bound([userId, ''], [userId, '\uffff'])));
  return values.sort((a, b) => b.createdAt - a.createdAt);
}
/** The ledger contains IDs only. Ordinary reply text is recovered from a revision-locked server draft. */
export async function enqueueOperation(userId: string, input: Pick<Operation, 'path' | 'body' | 'headers' | 'draft'>): Promise<Operation> {
  const allowed = new Set(['attachmentIds', 'conversationId', 'messageId', 'inReplyToId']);
  if (Object.keys(input.body ?? {}).some(key => !allowed.has(key))) throw new Error(t("m_ca0e0988cbd1"));
  if (!/^\/drafts\/[0-9a-f-]+\/send$|^\/conversations\/[0-9a-f-]+\/messages$|^\/mail\/reply$/i.test(input.path)) throw new Error(t("m_ba177b340868"));
  const pending = await listOperations(userId);
  if (pending.filter(p => p.state !== 'sent').length >= 100) throw new Error(t("m_72a8745b5557"));
  for (const record of pending.filter(p => p.state === 'sent').slice(20)) await records('readwrite', store => store.delete([userId, record.key]));
  const operation: Operation = { ...structuredClone(input), key: crypto.randomUUID(), accountId: userId, createdAt: Date.now(), attempts: 0, state: 'queued' };
  await save(operation);
  return operation;
}
export async function discardOperation(userId: string, key: string) {
  const value = await records<Operation | undefined>('readonly', store => store.get([userId, key]));
  if (value && !['failed', 'sent'].includes(value.state) && !(value.state === 'queued' && value.attempts === 0)) throw new Error(t("m_6ab364fc189f"));
  await records('readwrite', store => store.delete([userId, key])); notify();
}
export async function processOperation(userId: string, key: string): Promise<Operation> {
  return withBrowserLock('outbox:' + userId, async () => {
    const value = await records<Operation | undefined>('readonly', store => store.get([userId, key]));
    if (!value || value.accountId !== userId) throw new Error(t("m_91cfa6edb36f"));
    if (value.state === 'sent') return value;
    const account = await api<{ user: { id: string } }>('/auth/me');
    if (account.user.id !== userId) throw new Error(t("m_9b9760b596c9"));
    const commit = async (resourceId?: string) => { value.state = 'sent'; value.resourceId = resourceId; value.error = undefined; await save(value); return value; };
    const lookup = await api<{ operation: { resourceId: string } | null }>('/conversations/operations/' + encodeURIComponent(value.key))
      .catch(error => { if (error instanceof ApiError && error.status === 404) return { operation: null }; throw error; });
    if (lookup.operation) return commit(lookup.operation.resourceId);
    if (Date.now() - value.createdAt >= 23 * 60 * 60_000) {
      value.state = 'expired'; value.error = t("m_501eacab289b");
      await save(value); return value;
    }
    if (value.retryAt && value.retryAt > Date.now()) throw new Error(t("m_405a8d5892fb") + Math.ceil((value.retryAt - Date.now()) / 1000) + t("m_7bb0c42591c2"));
    try {
      let body = value.body ?? {};
      if (value.draft && !value.path.startsWith('/drafts/')) {
        const result = await api<{ draft: { revision: number; subject: string; body: string } }>('/drafts/' + value.draft.id);
        if (result.draft.revision !== value.draft.revision) throw new ApiError(409, 'REVISION_CONFLICT', t("m_c0c4e972e4c0"));
        body = { ...body, subject: result.draft.subject, body: result.draft.body };
      }
      value.state = 'unknown'; value.attempts += 1;
      await save(value); // Persist the identity before any request that could commit mail.
      const response = await api<{ message?: { id?: string; messageId?: string } }>(value.path, {
        method: 'POST', body, headers: { ...(value.headers ?? {}), 'Idempotency-Key': value.key },
      });
      return await commit(response?.message?.messageId || response?.message?.id);
    } catch (error) {
      const e = error as ApiError;
      value.state = !e.status || e.status >= 500 || [408, 429].includes(e.status) ? 'unknown' : 'failed';
      value.error = e.message || t("m_43795a9fb43d");
      value.retryAt = value.state === 'unknown' ? Date.now() + Math.max(e.retryAfter || 0, Math.min(60_000, 1000 * 2 ** Math.min(value.attempts, 6))) : undefined;
      await save(value); return value;
    }
  });
}
