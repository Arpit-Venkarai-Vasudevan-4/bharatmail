import {t} from '../i18n';
/** Bounded account-scoped ordinary mail cache. Persistent plaintext storage is explicit opt-in. */
const DB_NAME = 'phonemail-offline-v1';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SERVER_RECORDS = 700;
const POLICY_PREFIX = 'phonemail.offline.';
export class StorageError extends Error { constructor(message = t("m_45290156794f")) { super(message); this.name = 'StorageError'; } }
export interface LocalRecord<T = unknown> { account: string; bucket: string; key: string; value: T; updated: number }
export type StoreMutation = { bucket: string; key: string; value?: unknown; delete?: boolean };
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new StorageError()); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore('records', { keyPath: ['account', 'bucket', 'key'] });
      records.createIndex('account', 'account');
    };
    request.onerror = () => reject(new StorageError());
    request.onblocked = () => reject(new StorageError(t("m_83074a50d5fd")));
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
  }).catch(error => { database = undefined; throw error; });
  return database;
}
export function offlineEnabled(accountId: string): boolean {
  try { return localStorage.getItem(`${POLICY_PREFIX}${accountId}`) === 'allowed'; } catch { return false; }
}
export async function setOfflineEnabled(accountId: string, enabled: boolean): Promise<void> {
  try {
    if (enabled) { await db(); localStorage.setItem(`${POLICY_PREFIX}${accountId}`, 'allowed'); }
    else { await accountStore(accountId).clearPersistent(); localStorage.removeItem(`${POLICY_PREFIX}${accountId}`); }
    window.dispatchEvent(new Event('phonemail:offline-policy'));
  } catch { throw new StorageError(); }
}
function recordKey(record: Pick<LocalRecord, 'bucket' | 'key'>): string { return `${record.bucket}\u0000${record.key}`; }
function bounded(records: LocalRecord[]): LocalRecord[] {
  const pinned = records.filter(record => !record.bucket.startsWith('server:') && !record.bucket.startsWith('snapshot:') && record.bucket !== 'cache');
  const disposable = records.filter(record => !pinned.includes(record)).sort((a, b) => b.updated - a.updated).slice(0, MAX_SERVER_RECORDS);
  let bytes = JSON.stringify(pinned).length * 2;
  if (bytes > MAX_BYTES || pinned.length > 250) throw new StorageError(t("m_b6f06f4b8be0"));
  const result = [...pinned];
  for (const record of disposable) {
    const size = JSON.stringify(record).length * 2;
    if (bytes + size <= MAX_BYTES) { result.push(record); bytes += size; }
  }
  return result;
}
export class AccountStore {
  private memory = new Map<string, LocalRecord>();
  constructor(public readonly accountId: string) { if (!accountId) throw new Error(t("m_a0d61ed804c7")); }
  get durable(): boolean { return offlineEnabled(this.accountId); }
  async all<T = unknown>(bucket?: string): Promise<LocalRecord<T>[]> {
    let records: LocalRecord[];
    if (!this.durable) records = [...this.memory.values()];
    else {
      const database = await db();
      records = await new Promise<LocalRecord[]>((resolve, reject) => {
        const tx = database.transaction('records', 'readonly');
        const request = tx.objectStore('records').index('account').getAll(IDBKeyRange.only(this.accountId));
        request.onsuccess = () => resolve(request.result as LocalRecord[]);
        request.onerror = () => reject(new StorageError());
      });
    }
    return records.filter(record => record.account === this.accountId && (!bucket || record.bucket === bucket)) as LocalRecord<T>[];
  }
  async get<T>(bucket: string, key: string): Promise<T | undefined> { return (await this.all<T>(bucket)).find(record => record.key === key)?.value; }
  async put(bucket: string, key: string, value: unknown, requireDurable = false): Promise<void> {
    if (requireDurable && !this.durable) throw new StorageError(t("m_da951135e2ea"));
    await this.mutate(records => [...records.filter(record => record.bucket !== bucket || record.key !== key), { account: this.accountId, bucket, key, value, updated: Date.now() }]);
  }
  async remove(bucket: string, key: string): Promise<void> { await this.mutate(records => records.filter(record => record.bucket !== bucket || record.key !== key)); }
  async batch(changes: StoreMutation[]): Promise<void> {
    await this.mutate(records => {
      const map = new Map(records.map(record => [recordKey(record), record]));
      for (const change of changes) {
        const key = recordKey(change);
        if (change.delete) map.delete(key);
        else map.set(key, { account: this.accountId, bucket: change.bucket, key: change.key, value: change.value, updated: Date.now() });
      }
      return [...map.values()];
    });
  }
  /** Callback is synchronous: records and sync cursor commit in the same IndexedDB transaction. */
  async mutate(transform: (records: LocalRecord[]) => LocalRecord[]): Promise<void> {
    if (!this.durable) {
      const records = bounded(transform(structuredClone([...this.memory.values()])));
      this.memory = new Map(records.map(record => [recordKey(record), record])); return;
    }
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('records', 'readwrite');
      const table = tx.objectStore('records');
      const request = table.index('account').getAll(IDBKeyRange.only(this.accountId));
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const old = request.result as LocalRecord[];
          const next = bounded(transform(old)).filter(record => record.account === this.accountId);
          for (const record of old) table.delete([this.accountId, record.bucket, record.key]);
          for (const record of next) table.put(record);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(failure ?? new StorageError());
    });
  }
  clearMemory(): void { this.memory.clear(); }
  async clearPersistent(): Promise<void> {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('records', 'readwrite'); const table = tx.objectStore('records');
      const request = table.index('account').openKeyCursor(IDBKeyRange.only(this.accountId));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { table.delete(cursor.primaryKey); cursor.continue(); } };
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(new StorageError());
    });
    this.memory.clear();
  }
}
const accountStores = new Map<string, AccountStore>();
export function accountStore(id: string) { let store = accountStores.get(id); if (!store) { store = new AccountStore(id); accountStores.set(id, store); } return store; }
const LAST_ACCOUNT = 'phonemail.offline-last-account.v1';
export function rememberOfflineAccount(user: { id: string; [key: string]: unknown }) {
  try {
    if (offlineEnabled(user.id)) localStorage.setItem(LAST_ACCOUNT, JSON.stringify({ user, updated: Date.now() }));
    else localStorage.removeItem(LAST_ACCOUNT);
  } catch { /* Mail storage reports its own error; remembering a view is optional. */ }
}
export function readOfflineAccount(): { id: string; [key: string]: unknown } | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_ACCOUNT) || 'null');
    if (saved?.user && typeof saved.user.id === 'string' && offlineEnabled(saved.user.id) && Date.now() - saved.updated < 7 * 86400_000) return saved.user;
  } catch { /* Invalid or denied storage does not constitute a session. */ }
}
export function forgetOfflineAccount() { try { localStorage.removeItem(LAST_ACCOUNT); } catch { /* Optional preference */ } }
