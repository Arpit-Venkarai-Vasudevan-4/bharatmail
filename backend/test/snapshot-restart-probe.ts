import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import test from "node:test";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const statePath = process.env.PHONEMAIL_SNAPSHOT_RESTART_STATE;
if (!statePath) throw new Error("Snapshot restart probe requires a disposable state-file path");

type State = { userId: string; token: string; snapshotId: string; cursor: string; watermark: string };

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function begin() {
  const registration = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
  const { id: userId } = registration.body.user as { id: string };
  try {
    await query(
      `INSERT INTO drafts(user_id,subject,body)
       SELECT $1,'restart-snapshot-'||g,'restart fixture'
         FROM generate_series(1,10001) AS g`,
      [userId],
    );
    const page = await request("/api/sync/snapshot?limit=1", {}, registration.body.token);
    assert.equal(page.response.status, 200, JSON.stringify(page.body));
    assert.ok(Number(page.body.totalRecords) > 10_000);
    assert.equal((await query<{ snapshot_mode: string }>(
      "SELECT snapshot_mode FROM sync_snapshot_sessions WHERE id=$1",
      [page.body.snapshotId],
    )).rows[0].snapshot_mode, "streaming");
    const state: State = {
      userId,
      token: registration.body.token,
      snapshotId: page.body.snapshotId,
      cursor: page.body.nextCursor,
      watermark: page.body.watermark,
    };
    await writeFile(statePath, JSON.stringify(state), { flag: "wx" });
    console.log("Started a large streaming snapshot; restart fixture saved outside logs.");
  } catch (error) {
    await query("DELETE FROM users WHERE id=$1", [userId]);
    throw error;
  }
}

async function resume() {
  const state = JSON.parse(await readFile(statePath, "utf8")) as State;
  try {
    const continuation = await request(
      `/api/sync/snapshot?snapshotId=${state.snapshotId}&cursor=${encodeURIComponent(state.cursor)}&limit=10`,
      {},
      state.token,
    );
    assert.equal(continuation.response.status, 409, JSON.stringify(continuation.body));
    assert.equal(continuation.body.error.code, "SNAPSHOT_INSTANCE_AFFINITY_REQUIRED");

    const newDraft = await request("/api/drafts", {
      method: "POST",
      body: JSON.stringify({ subject: "Post-restart handoff", body: "Recover using the original watermark" }),
    }, state.token);
    assert.equal(newDraft.response.status, 201, JSON.stringify(newDraft.body));
    const changes = await request(`/api/sync?cursor=${encodeURIComponent(state.watermark)}&limit=100`, {}, state.token);
    assert.equal(changes.response.status, 200, JSON.stringify(changes.body));
    assert.ok(changes.body.changes.some((change: { entity_id: string }) => change.entity_id === newDraft.body.draft.id));

    const replacement = await request("/api/sync/snapshot?limit=1", {}, state.token);
    assert.equal(replacement.response.status, 200, JSON.stringify(replacement.body));
    assert.notEqual(replacement.body.snapshotId, state.snapshotId);
    assert.equal((await request(`/api/sync/snapshot/${replacement.body.snapshotId}/close`, { method: "POST" }, state.token)).response.status, 204);
    console.log("Restarted snapshots return the documented affinity error; the original watermark and a fresh snapshot recover safely.");
  } finally {
    await cleanupState(state);
  }
}

async function cleanupState(state?: State) {
  const existing = state ?? JSON.parse(await readFile(statePath, "utf8")) as State;
  try {
    await query("DELETE FROM users WHERE id=$1", [existing.userId]);
  } finally {
    await unlink(statePath).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
  }
}

const phase = process.argv[2];
const run = phase === "begin" ? begin : phase === "resume" ? resume : phase === "cleanup" ? cleanupState : undefined;
if (!run) throw new Error("Expected snapshot restart phase 'begin', 'resume', or 'cleanup'");
run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Snapshot restart probe failed");
  process.exitCode = 1;
});
