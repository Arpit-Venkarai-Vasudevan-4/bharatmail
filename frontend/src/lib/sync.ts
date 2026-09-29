import {t} from '../i18n';
import { api, ApiError, withBrowserLock } from './api';
import { accountStore, type LocalRecord } from './storage';
type RecordData = { entity_type: string; entity_id: string; payload: Record<string, unknown>; action?: string; revision?: string };
type Snapshot = { snapshotId: string; watermark: string; expiresAt: string; records: RecordData[]; hasMore: boolean; nextCursor: string | null; incrementalCursor: string | null };
type State = { cursor?: string; snapshotId?: string; pageCursor?: string; expiresAt?: string; updated?: number };
const revision = (value: unknown): string => { if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(t("m_905dc3cb6ffc")); return value; };
function record(account: string, bucket: string, key: string, value: unknown): LocalRecord { return { account, bucket, key, value, updated: Date.now() }; }

/** Bounded metadata cache, not a complete offline replica. Cursor and changes commit together. */
export async function syncAccount(accountId: string, signal: AbortSignal): Promise<{ changed: boolean; more: boolean }> {
  return withBrowserLock('sync:' + accountId, async () => {
    const store = accountStore(accountId);
    const identity = await api<{ user: { id: string } }>('/auth/me', { signal });
    if (identity.user.id !== accountId) throw new Error(t("m_891b852484f8"));
    let state = await store.get<State>('sync', 'state') || {};
    try {
      if (!state.cursor || state.snapshotId) {
        const query = new URLSearchParams({ limit: '100' });
        if (state.snapshotId) { query.set('snapshotId', state.snapshotId); if (state.pageCursor) query.set('cursor', state.pageCursor); }
        const page = await api<Snapshot>('/sync/snapshot?' + query, { signal });
        revision(page.watermark);
        if (page.hasMore && !page.nextCursor) throw new Error(t("m_6bb1b411ba6a"));
        if (!page.hasMore && revision(page.incrementalCursor) !== page.watermark) throw new Error(t("m_89e69db23a10"));
        if (signal.aborted) return { changed: false, more: false };
        const bucket = 'snapshot:' + page.snapshotId;
        await store.mutate(existing => {
          const map = new Map(existing.map(r => [r.bucket + ':' + r.key, r]));
          for (const item of page.records) { const key = item.entity_type + ':' + item.entity_id; map.set(bucket + ':' + key, record(accountId, bucket, key, item)); }
          let next = [...map.values()];
          if (page.hasMore) {
            next = next.filter(r => r.bucket !== 'sync');
            next.push(record(accountId, 'sync', 'state', { snapshotId: page.snapshotId, pageCursor: page.nextCursor, expiresAt: page.expiresAt }));
          } else {
            // Publish the completed generation atomically. Local drafts and send records are untouched.
            const staged = next.filter(r => r.bucket === bucket).map(r => { const item = r.value as RecordData; return record(accountId, 'server:' + item.entity_type, item.entity_id, item.payload); });
            next = next.filter(r => !r.bucket.startsWith('server:') && !r.bucket.startsWith('snapshot:') && r.bucket !== 'sync' && r.bucket !== 'cache');
            next.push(...staged, record(accountId, 'sync', 'state', { cursor: page.incrementalCursor, updated: Date.now() }));
          }
          return next;
        });
        if (!page.hasMore) await api('/sync/snapshot/' + page.snapshotId + '/close', { method: 'POST', signal }).catch(() => {});
        return { changed: !page.hasMore, more: page.hasMore };
      }
      const page = await api<{ changes: RecordData[]; cursor: string; hasMore: boolean }>('/sync?limit=100&cursor=' + encodeURIComponent(state.cursor), { signal });
      const cursor = revision(page.cursor);
      if (BigInt(cursor) < BigInt(revision(state.cursor))) throw new Error(t("m_1b399533a706"));
      if (signal.aborted) return { changed: false, more: false };
      await store.mutate(existing => {
        const map = new Map(existing.filter(r => r.bucket !== 'sync' && (!page.changes.length || r.bucket !== 'cache')).map(r => [r.bucket + ':' + r.key, r]));
        for (const change of page.changes) {
          const bucket = 'server:' + change.entity_type, key = bucket + ':' + change.entity_id;
          if (change.action === 'deleted' || change.payload.deleted === true) map.delete(key);
          else map.set(key, record(accountId, bucket, change.entity_id, { ...(map.get(key)?.value as object || {}), ...change.payload }));
        }
        return [...map.values(), record(accountId, 'sync', 'state', { cursor, updated: Date.now() })];
      });
      return { changed: page.changes.length > 0, more: page.hasMore };
    } catch (e) {
      if (e instanceof ApiError && (e.status === 410 || (state.snapshotId && e.status === 404))) {
        // Keep the old active generation until a fresh snapshot completes.
        await store.mutate(records => records.filter(r => r.bucket !== 'sync' && !r.bucket.startsWith('snapshot:')));
        return { changed: false, more: true };
      }
      throw e;
    }
  });
}
