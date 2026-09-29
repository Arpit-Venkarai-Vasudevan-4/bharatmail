import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, secondaryBase } = integrationTargets();
const { query } = require("../src/db") as typeof import("../src/db");
const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

test("sync snapshots preserve the 10,000-row cap and stream complete larger state with an incremental handoff", async () => {
  const phone = await randomTestPhone();
  let userId: string | undefined;
  let token: string | undefined;
  let streamingSnapshotId: string | undefined;
  try {
    const registered = await request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        phone,
        password: "StrongPass!123",
        termsAccepted: true,
      }),
    });
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
    userId = registered.body.user.id;
    token = registered.body.token;

    await query(
      "INSERT INTO contacts(owner_user_id,address_snapshot,label,notes) VALUES($1,$2,$3,'')",
      [userId, `snapshot-${suffix}@phonemail.com`, "Snapshot fixture"],
    );
    const seeded = await query<{ id: string }>(
      `INSERT INTO drafts(user_id,subject,body)
       SELECT $1,'large-snapshot-'||$2||'-'||g,'private draft body '||g
         FROM generate_series(0,9995) AS g
       RETURNING id`,
      [userId, suffix],
    );
    assert.equal(seeded.rows.length, 9996);
    const below = await request("/api/sync/snapshot?limit=1", {}, token);
    assert.equal(below.response.status, 200, JSON.stringify(below.body));
    assert.equal(below.body.totalRecords, "9999");
    assert.equal((await query<{ snapshot_mode: string }>(
      "SELECT snapshot_mode FROM sync_snapshot_sessions WHERE id=$1",
      [below.body.snapshotId],
    )).rows[0].snapshot_mode, "materialized");

    await query(
      "INSERT INTO drafts(user_id,subject,body) VALUES($1,$2,'at-boundary body')",
      [userId, `at-boundary-${suffix}`],
    );
    const atBoundary = await request("/api/sync/snapshot?limit=1", {}, token);
    assert.equal(atBoundary.response.status, 200, JSON.stringify(atBoundary.body));
    assert.equal(atBoundary.body.totalRecords, "10000");
    assert.equal((await query<{ snapshot_mode: string }>(
      "SELECT snapshot_mode FROM sync_snapshot_sessions WHERE id=$1",
      [atBoundary.body.snapshotId],
    )).rows[0].snapshot_mode, "materialized");

    await query(
      "INSERT INTO drafts(user_id,subject,body) VALUES($1,$2,'over-boundary body')",
      [userId, `over-boundary-${suffix}`],
    );
    const first = await request("/api/sync/snapshot?limit=1", {}, token);
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.totalRecords, "10001");
    streamingSnapshotId = first.body.snapshotId;
    assert.equal((await query<{ snapshot_mode: string }>(
      "SELECT snapshot_mode FROM sync_snapshot_sessions WHERE id=$1",
      [streamingSnapshotId],
    )).rows[0].snapshot_mode, "streaming");
    const firstExpiryMs = Date.parse(first.body.expiresAt) - Date.parse(first.body.serverTime);
    assert.ok(firstExpiryMs > 14 * 60 * 1000 && firstExpiryMs <= 15 * 60 * 1000, "production streaming snapshot TTL must remain 15 minutes");
    if (secondaryBase) {
      const otherInstance = await fetch(`${secondaryBase}/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(first.body.nextCursor)}&limit=10`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(otherInstance.status, 409);
      const otherBody = await otherInstance.json() as any;
      assert.equal(otherBody.error.code, "SNAPSHOT_INSTANCE_AFFINITY_REQUIRED");
      assert.equal((await query("SELECT 1 FROM sync_snapshot_sessions WHERE id=$1", [streamingSnapshotId])).rowCount, 1);
    }
    assert.equal(first.body.records[0].entity_type, "account");
    assert.match(first.body.nextCursor, /^account:[0-9a-f-]{36}$/i);
    const abandonedPage = await fetch(
      `${base}/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(first.body.nextCursor)}&limit=50`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(abandonedPage.status, 200);
    await abandonedPage.body?.cancel();
    const resumedPage = await request(
      `/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(first.body.nextCursor)}&limit=50`,
      {},
      token,
    );
    assert.equal(resumedPage.response.status, 200, JSON.stringify(resumedPage.body));
    assert.ok(resumedPage.body.records.length > 0, "an abandoned page must be recoverable from its unchanged cursor");
    const unrelatedHealth = await fetch(`${base}/health`);
    assert.equal(unrelatedHealth.status, 200, "abandoned pagination must not block unrelated API requests");

    const deletedDraftId = seeded.rows[0].id;
    const deletion = await request(`/api/drafts/${deletedDraftId}`, { method: "DELETE" }, token);
    assert.equal(deletion.response.status, 204);
    const createdDuringSnapshot = await request("/api/drafts", {
      method: "POST",
      body: JSON.stringify({ subject: `during-${suffix}`, body: "arrives through sync changes" }),
    }, token);
    assert.equal(createdDuringSnapshot.response.status, 201, JSON.stringify(createdDuringSnapshot.body));

    const records = [...first.body.records];
    let page = first.body;
    let cursor = page.nextCursor;
    let pageCount = 1;
    while (page.hasMore) {
      const next = await request(
        `/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(cursor)}&limit=50`,
        {},
        token,
      );
      assert.equal(next.response.status, 200, JSON.stringify(next.body));
      records.push(...next.body.records);
      page = next.body;
      cursor = page.nextCursor;
      pageCount += 1;
      assert.ok(pageCount <= Math.ceil(10001 / 50) + 2, "large snapshot continuation must terminate");
    }
    assert.equal(records.length, 10001);
    assert.equal(new Set(records.map((record: any) => `${record.entity_type}:${record.entity_id}`)).size, records.length);
    assert.deepEqual(new Set(records.map((record: any) => record.entity_type)), new Set(["account", "address", "contact", "draft"]));
    const snapshotDrafts = records.filter((record: any) => record.entity_type === "draft");
    assert.equal(snapshotDrafts.length, 9998);
    assert.ok(snapshotDrafts.some((record: any) => record.entity_id === deletedDraftId));
    assert.ok(!snapshotDrafts.some((record: any) => record.entity_id === createdDuringSnapshot.body.draft.id));
    assert.ok(snapshotDrafts.every((record: any) => !Object.hasOwn(record.payload, "body")));
    assert.equal(page.incrementalCursor, first.body.watermark);
    assert.equal(page.nextCursor, null);

    const changes = await request(`/api/sync?cursor=${encodeURIComponent(page.incrementalCursor)}&limit=100`, {}, token);
    assert.equal(changes.response.status, 200, JSON.stringify(changes.body));
    assert.ok(changes.body.changes.some((change: any) => change.entity_id === deletedDraftId && change.action === "deleted"));
    assert.ok(changes.body.changes.some((change: any) => change.entity_id === createdDuringSnapshot.body.draft.id && change.action === "upserted"));
    const closed = await request(`/api/sync/snapshot/${streamingSnapshotId}/close`, { method: "POST" }, token);
    assert.equal(closed.response.status, 204);
    streamingSnapshotId = undefined;

    const extendedSeed = await query<{ id: string }>(
      `INSERT INTO drafts(user_id,subject,body)
       SELECT $1,'extended-snapshot-'||$2||'-'||g,'extended private body '||g
         FROM generate_series(1,2000) AS g
       RETURNING id`,
      [userId, suffix],
    );
    assert.equal(extendedSeed.rows.length, 2000);
    const extendedFirst = await request("/api/sync/snapshot?limit=100", {}, token);
    assert.equal(extendedFirst.response.status, 200, JSON.stringify(extendedFirst.body));
    assert.equal(extendedFirst.body.totalRecords, "12001");
    streamingSnapshotId = extendedFirst.body.snapshotId;
    const extendedRecords = [...extendedFirst.body.records];
    let extendedPage = extendedFirst.body;
    let extendedCursor = extendedPage.nextCursor;
    let extendedPageCount = 1;
    while (extendedPage.hasMore) {
      const next = await request(
        `/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(extendedCursor)}&limit=100`,
        {},
        token,
      );
      assert.equal(next.response.status, 200, JSON.stringify(next.body));
      extendedRecords.push(...next.body.records);
      extendedPage = next.body;
      extendedCursor = extendedPage.nextCursor;
      extendedPageCount += 1;
      assert.ok(extendedPageCount <= Math.ceil(12001 / 100) + 2, "extended snapshot continuation must terminate");
    }
    assert.equal(extendedRecords.length, 12001);
    assert.equal(new Set(extendedRecords.map((record: any) => `${record.entity_type}:${record.entity_id}`)).size, 12001);
    const expectedDraftIds = (await query<{ id: string }>(
      "SELECT id FROM drafts WHERE user_id=$1 ORDER BY id",
      [userId],
    )).rows.map(({ id }) => id);
    const actualDraftIds = extendedRecords
      .filter((record: any) => record.entity_type === "draft")
      .map((record: any) => record.entity_id)
      .sort();
    assert.deepEqual(actualDraftIds, expectedDraftIds);
    assert.ok(extendedRecords.every((record: any) => record.entity_type !== "draft" || !Object.hasOwn(record.payload, "body")));
    const extendedClose = await request(`/api/sync/snapshot/${streamingSnapshotId}/close`, { method: "POST" }, token);
    assert.equal(extendedClose.response.status, 204);
    streamingSnapshotId = undefined;

    const activityBeforeExpiry = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
    );
    await query(
      "UPDATE sync_snapshot_create_limits SET window_started_at=now()-interval '2 minutes',request_count=0 WHERE user_id=$1",
      [userId],
    );
    const concurrent = await Promise.all([
      request("/api/sync/snapshot?limit=10", {}, token),
      request("/api/sync/snapshot?limit=10", {}, token),
    ]);
    assert.ok(concurrent.every((result) => result.response.status === 200), JSON.stringify(concurrent.map((result) => result.body)));
    const closeOne = await request(`/api/sync/snapshot/${concurrent[0].body.snapshotId}/close`, { method: "POST" }, token);
    assert.equal(closeOne.response.status, 204);
    streamingSnapshotId = concurrent[1].body.snapshotId;
    await query("UPDATE sync_snapshot_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [streamingSnapshotId]);
    const expired = await request(
      `/api/sync/snapshot?snapshotId=${streamingSnapshotId}&cursor=${encodeURIComponent(concurrent[1].body.nextCursor)}&limit=10`,
      {},
      token,
    );
    assert.equal(expired.response.status, 410, JSON.stringify(expired.body));
    assert.equal(expired.body.error.code, "SNAPSHOT_EXPIRED");
    assert.equal((await query("SELECT 1 FROM sync_snapshot_sessions WHERE id=$1", [streamingSnapshotId])).rowCount, 0);
    streamingSnapshotId = undefined;
    const activityAfterExpiry = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
    );
    assert.ok(activityAfterExpiry.rows[0].count <= activityBeforeExpiry.rows[0].count, "expired snapshots must release their PostgreSQL transaction client");
  } finally {
    if (streamingSnapshotId && token) {
      await request(`/api/sync/snapshot/${streamingSnapshotId}/close`, { method: "POST" }, token);
    }
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
  }
});
