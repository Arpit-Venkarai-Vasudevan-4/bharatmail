import assert from "node:assert/strict";
import { createServer, request as createRequest } from "node:http";
import { Transform } from "node:stream";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const proxyPort = Number(new URL(base).port);
if (proxyPort !== 3344) throw new Error("Network regression must target the isolated loopback proxy on port 3344");

const network = {
  requests: 0,
  constrainedRequests: 0,
  upstreamBytes: 0,
  downstreamBytes: 0,
  droppedResponses: 0,
  interruptedUploads: 0,
};
const upstreamBase = process.env.PHONEMAIL_TEST_UPSTREAM_URL ?? "http://127.0.0.1:3331";
let didInterruptUpload = false;
const droppedResponseTags = new Set<string>();
let upstreamAvailableAt = 0;
let downstreamAvailableAt = 0;

function sharedTransferDelay(direction: "upstream" | "downstream", bytes: number): number {
  const now = performance.now();
  const availableAt = direction === "upstream" ? upstreamAvailableAt : downstreamAvailableAt;
  const nextAvailableAt = Math.max(now, availableAt) + (bytes * 1000) / 32_000;
  if (direction === "upstream") upstreamAvailableAt = nextAvailableAt;
  else downstreamAvailableAt = nextAvailableAt;
  return nextAvailableAt - now;
}

const proxy = createServer((incoming, outgoing) => {
  if (incoming.url === "/__proxy_metrics") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify(network));
    return;
  }

  network.requests += 1;
  const constrained = incoming.headers["x-network-profile"] === "constrained";
  if (constrained) network.constrainedRequests += 1;
  const dropTag = incoming.headers["x-test-drop-response-once"];
  const dropResponse = typeof dropTag === "string" && !droppedResponseTags.has(dropTag);
  if (dropResponse) droppedResponseTags.add(dropTag);
  const interruptUpload = incoming.headers["x-test-interrupt-upload"] === "after-16-bytes" && !didInterruptUpload;
  if (interruptUpload) didInterruptUpload = true;

  const upstreamTarget = new URL(upstreamBase);
  const headers = { ...incoming.headers, host: upstreamTarget.host };
  delete headers["x-network-profile"];
  delete headers["x-test-drop-response-once"];
  delete headers["x-test-interrupt-upload"];

  const upstream = createRequest({
    hostname: upstreamTarget.hostname,
    port: Number(upstreamTarget.port || 80),
    method: incoming.method,
    path: incoming.url,
    headers,
  });
  upstream.on("error", () => {
    if (!outgoing.destroyed && !outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("upstream unavailable");
    } else if (!outgoing.destroyed) {
      outgoing.destroy();
    }
  });

  if (interruptUpload) {
    let forwarded = 0;
    incoming.on("data", (chunk: Buffer) => {
      if (forwarded >= 16 || upstream.destroyed) return;
      const part = chunk.subarray(0, 16 - forwarded);
      forwarded += part.length;
      network.upstreamBytes += part.length;
      upstream.write(part);
      if (forwarded === 16) {
        network.interruptedUploads += 1;
        setTimeout(() => {
          upstream.destroy();
          if (!outgoing.destroyed) outgoing.destroy();
        }, 40);
      }
    });
    incoming.on("error", () => undefined);
    return;
  }

  const start = () => {
    const requestLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        network.upstreamBytes += chunk.length;
        if (!constrained) {
          callback(null, chunk);
          return;
        }
        setTimeout(() => callback(null, chunk), Math.ceil(sharedTransferDelay("upstream", chunk.length)));
      },
    });
    incoming.pipe(requestLimiter).pipe(upstream);
    upstream.on("response", (response) => {
      const sendResponse = () => {
        if (dropResponse) {
          response.resume();
          response.once("end", () => {
            network.droppedResponses += 1;
            outgoing.destroy();
          });
          return;
        }
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        const responseLimiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            network.downstreamBytes += chunk.length;
            if (!constrained) {
              callback(null, chunk);
              return;
            }
            setTimeout(() => callback(null, chunk), Math.ceil(sharedTransferDelay("downstream", chunk.length)));
          },
        });
        response.pipe(responseLimiter).pipe(outgoing);
      };
      if (constrained) setTimeout(sendResponse, 180);
      else sendResponse();
    });
  };
  if (constrained) setTimeout(start, 180);
  else start();
});

async function closeProxy() {
  if (!proxy.listening) return;
  await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
}

function api(path: string, init: RequestInit = {}, constrained = false, faultHeader?: [string, string]) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(constrained ? { "x-network-profile": "constrained" } : {}),
      ...(faultHeader ? { [faultHeader[0]]: faultHeader[1] } : {}),
      ...(init.headers ?? {}),
    },
  });
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(percentileValue * ordered.length) - 1)];
}

async function profileRequests(token: string, count: number, constrained: boolean) {
  const latencies: number[] = [];
  const payloadSizes: number[] = [];
  let sampling = true;
  let peakConnections = 0;
  const started = performance.now();
  const monitor = (async () => {
    while (sampling) {
      const active = await query<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database()",
      );
      peakConnections = Math.max(peakConnections, active.rows[0]?.count ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  try {
    await Promise.all(Array.from({ length: count }, async () => {
      const started = performance.now();
      const response = await api("/api/me", { headers: { authorization: `Bearer ${token}` } }, constrained);
      const payload = await response.arrayBuffer();
      assert.equal(response.status, 200);
      latencies.push(performance.now() - started);
      payloadSizes.push(payload.byteLength);
    }));
  } finally {
    sampling = false;
    await monitor;
  }
  return {
    requests: count,
    concurrency: count,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(1)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    medianPayloadBytes: percentile(payloadSizes, 0.5),
    peakDatabaseConnections: peakConnections,
  };
}

test("constrained network retries preserve messages and reconcile interrupted resumable uploads", async (t) => {
  const upstreamHealth = await fetch(`${upstreamBase}/ready`);
  assert.equal(upstreamHealth.status, 200, "fixed upstream must be the healthy Stage 3 acceptance API");
  const upstreamReady = await upstreamHealth.json() as { status: string };
  assert.equal(upstreamReady.status, "ready");
  const databaseTarget = await query<{ database_name: string; port: number }>(
    "SELECT current_database() AS database_name, inet_server_port() AS port",
  );
  assert.deepEqual(databaseTarget.rows[0], { database_name: "phonemail_test", port: 5432 });

  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(proxyPort, "127.0.0.1", () => resolve());
  });

  const [ownerPhone, recipientPhone] = await Promise.all([randomTestPhone(), randomTestPhone()]);
  const userIds: string[] = [];
  let uploadId: string | undefined;
  let chunkUploadId: string | undefined;
  t.after(async () => {
    await closeProxy();
    if (userIds.length) await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [userIds]);
    if (uploadId) {
      const key = await query<{ storage_key: string }>("SELECT storage_key FROM uploads WHERE id=$1", [uploadId]);
      if (key.rows[0]) {
        await query("DELETE FROM uploads WHERE id=$1", [uploadId]);
      }
    }
    if (chunkUploadId) await query("DELETE FROM uploads WHERE id=$1", [chunkUploadId]);
  });

  const started = Date.now();
  const constrainedHealth = await api("/api/capabilities", {}, true);
  assert.equal(constrainedHealth.status, 200);
  const constrainedElapsedMs = Date.now() - started;
  const ownerResult = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: ownerPhone, password: "StrongPass!123", displayName: "Network owner", termsAccepted: true }),
  });
  assert.equal(ownerResult.status, 201);
  const owner = await ownerResult.json() as { user: { id: string }; token: string };
  userIds.push(owner.user.id);
  const recipientResult = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: recipientPhone, password: "StrongPass!123", displayName: "Network recipient", termsAccepted: true }),
  });
  assert.equal(recipientResult.status, 201);
  const recipient = await recipientResult.json() as { user: { id: string } };
  userIds.push(recipient.user.id);
  const normalBaseline = await profileRequests(owner.token, 30, false);
  const constrainedProfile = await profileRequests(owner.token, 30, true);

  const conversationResult = await api("/api/conversations", {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ participantPhones: [recipientPhone] }),
  });
  assert.equal(conversationResult.status, 201);
  const conversation = await conversationResult.json() as { conversation: { id: string } };

  const idempotencyKey = `network-${randomUUID()}`;
  const messageRequest = {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}`, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ subject: "Network recovery fixture", body: "Commit once, recover the lost response." }),
  };
  await assert.rejects(
    api(`/api/conversations/${conversation.conversation.id}/messages`, messageRequest, true, ["x-test-drop-response-once", "true"]),
  );
  const retryStarted = Date.now();
  const retried = await api(`/api/conversations/${conversation.conversation.id}/messages`, messageRequest, true);
  const retryElapsedMs = Date.now() - retryStarted;
  assert.equal(retried.status, 201);
  const recovered = await retried.json() as { message: { id: string } };

  const createUpload = await api("/api/uploads", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "X-Upload-Mode": "resumable",
      "X-Filename": "interrupted-network.bin",
      "X-Expected-Bytes": "64",
    },
  }, true);
  assert.equal(createUpload.status, 201);
  const created = await createUpload.json() as { upload: { id: string; status: string } };
  uploadId = created.upload.id;
  assert.equal(created.upload.status, "staged");
  const uploadBody = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@");
  assert.equal(uploadBody.length, 64);
  await assert.rejects(api(`/api/uploads/${uploadId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "X-Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
    body: uploadBody,
  }, true, ["x-test-interrupt-upload", "after-16-bytes"]));

  const reconciled = await api(`/api/uploads/${uploadId}/status`, {
    headers: { authorization: `Bearer ${owner.token}` },
  });
  assert.equal(reconciled.status, 200);
  const current = await reconciled.json() as { upload: { offset: number; status: string } };
  assert.equal(current.upload.offset, 0);
  assert.equal(current.upload.status, "staged");

  const completed = await api(`/api/uploads/${uploadId}`, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "X-Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
    body: uploadBody,
  }, true);
  assert.equal(completed.status, 200);
  const download = await api(`/api/uploads/${uploadId}`, {
    headers: { authorization: `Bearer ${owner.token}`, range: "bytes=0-63" },
  });
  assert.equal(download.status, 206);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), uploadBody);

  const largeBody = Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251));
  const createChunked = await api("/api/uploads", {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.token}`,
      "X-Upload-Mode": "resumable",
      "X-Filename": "multi-chunk-network.bin",
      "X-Expected-Bytes": String(largeBody.length),
    },
  }, true);
  assert.equal(createChunked.status, 201);
  chunkUploadId = ((await createChunked.json()) as { upload: { id: string } }).upload.id;
  const chunkSize = 2048;
  for (let offset = 0; offset < largeBody.length; offset += chunkSize) {
    const chunk = await api(`/api/uploads/${chunkUploadId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${owner.token}`,
        "X-Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: largeBody.subarray(offset, offset + chunkSize),
    }, true);
    assert.equal(chunk.status, 200);
    assert.equal(((await chunk.json()) as { upload: { offset: number } }).upload.offset, offset + chunkSize);
  }
  const rangedChunks: Buffer[] = [];
  for (let start = 0; start < largeBody.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, largeBody.length) - 1;
    const range = await api(`/api/uploads/${chunkUploadId}`, {
      headers: { authorization: `Bearer ${owner.token}`, range: `bytes=${start}-${end}` },
    }, true);
    assert.equal(range.status, 206);
    rangedChunks.push(Buffer.from(await range.arrayBuffer()));
  }
  assert.deepEqual(Buffer.concat(rangedChunks), largeBody);
  const chunkUploadState = await query<{ status: string; offset_bytes: number }>(
    "SELECT status,offset_bytes FROM uploads WHERE id=$1 AND user_id=$2",
    [chunkUploadId, owner.user.id],
  );
  assert.deepEqual(chunkUploadState.rows[0], { status: "ready", offset_bytes: largeBody.length });

  const fixtureDraftIds: string[] = [];
  for (let index = 0; index < 17; index += 1) {
    const draft = await api("/api/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ subject: `sync fixture ${index}`, body: `paged sync record ${index}` }),
    }, true);
    assert.equal(draft.status, 201);
    fixtureDraftIds.push(((await draft.json()) as { draft: { id: string } }).draft.id);
  }
  const initialSnapshot = await api("/api/sync/snapshot?limit=5", {
    headers: { authorization: `Bearer ${owner.token}` },
  }, true);
  assert.equal(initialSnapshot.status, 200);
  let snapshotPage = await initialSnapshot.json() as {
    snapshotId: string;
    records: Array<{ entity_type: string; entity_id: string }>;
    hasMore: boolean;
    nextCursor: string | null;
    incrementalCursor: string | null;
  };
  const snapshotId = snapshotPage.snapshotId;
  const snapshotRecords = [...snapshotPage.records];
  let continuationResponseRetried = false;
  while (snapshotPage.hasMore) {
    const path = `/api/sync/snapshot?snapshotId=${snapshotId}&cursor=${encodeURIComponent(snapshotPage.nextCursor!)}&limit=5`;
    if (!continuationResponseRetried) {
      await assert.rejects(api(path, {
        headers: { authorization: `Bearer ${owner.token}` },
      }, true, ["x-test-drop-response-once", "sync-page"]));
      continuationResponseRetried = true;
    }
    const next = await api(path, {
      headers: { authorization: `Bearer ${owner.token}` },
    }, true);
    assert.equal(next.status, 200);
    snapshotPage = await next.json() as typeof snapshotPage;
    snapshotRecords.push(...snapshotPage.records);
  }
  const authoritativeDrafts = await query<{ id: string }>(
    "SELECT id FROM drafts WHERE user_id=$1 ORDER BY id",
    [owner.user.id],
  );
  const snapshotDraftIds = snapshotRecords.filter((record) => record.entity_type === "draft")
    .map((record) => record.entity_id).sort();
  assert.deepEqual(snapshotDraftIds, [...fixtureDraftIds].sort());
  assert.deepEqual(snapshotDraftIds, authoritativeDrafts.rows.map((row) => row.id));
  assert.ok(snapshotPage.incrementalCursor);
  const postSnapshotDraft = await api("/api/drafts", {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
    body: JSON.stringify({ subject: "incremental handoff", body: "created after the stable snapshot" }),
  }, true);
  assert.equal(postSnapshotDraft.status, 201);
  const postSnapshotDraftId = ((await postSnapshotDraft.json()) as { draft: { id: string } }).draft.id;
  const incremental = await api(`/api/sync?cursor=${encodeURIComponent(snapshotPage.incrementalCursor)}&limit=50`, {
    headers: { authorization: `Bearer ${owner.token}` },
  }, true);
  assert.equal(incremental.status, 200);
  assert.ok(((await incremental.json()) as { changes: Array<{ entity_id: string; action: string }> }).changes
    .some((change) => change.entity_id === postSnapshotDraftId && change.action === "upserted"));
  const closeSnapshot = await api(`/api/sync/snapshot/${snapshotId}/close`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner.token}` },
  }, true);
  assert.equal(closeSnapshot.status, 204);
  assert.equal(continuationResponseRetried, true);

  const persisted = await query<{ message_count: string; upload_status: string; upload_offset: number }>(
    `SELECT (SELECT count(*)::text FROM messages WHERE conversation_id=$1 AND sender_user_id=$2) AS message_count,
            u.status AS upload_status,u.offset_bytes AS upload_offset
       FROM uploads u WHERE u.id=$3 AND u.user_id=$2`,
    [conversation.conversation.id, owner.user.id, uploadId],
  );
  assert.equal(persisted.rows[0]?.message_count, "1");
  assert.equal(persisted.rows[0]?.upload_status, "ready");
  assert.equal(persisted.rows[0]?.upload_offset, uploadBody.length);

  const metrics = await fetch(`${base}/__proxy_metrics`).then((result) => result.json()) as {
    constrainedRequests: number; upstreamBytes: number; downstreamBytes: number;
    droppedResponses: number; interruptedUploads: number;
  };
  assert.ok(metrics.constrainedRequests >= 3);
  assert.ok(metrics.upstreamBytes > 64 && metrics.downstreamBytes > 64);
  assert.equal(metrics.droppedResponses, 2);
  assert.equal(metrics.interruptedUploads, 1);
  assert.ok(constrainedElapsedMs >= 300);
  assert.ok(retryElapsedMs >= 300);
  console.info(JSON.stringify({
    event: "network_regression_measurement",
    profiles: {
      normal: { addedLatencyMs: 0, throughputLimit: "none", ...normalBaseline },
      constrained: { oneWayLatencyMs: 180, throughputBytesPerSecond: 32_000, ...constrainedProfile },
    },
    fixtures: {
      retryMessageCount: persisted.rows[0].message_count,
      interruptedUploadBytes: uploadBody.length,
      multiChunkUploadBytes: largeBody.length,
      uploadChunkBytes: chunkSize,
      uploadChunks: largeBody.length / chunkSize,
      syncRecordCount: snapshotRecords.length,
      syncPageSize: 5,
      retriedSyncPage: continuationResponseRetried,
    },
    timings: { constrainedCapabilitiesMs: constrainedElapsedMs, constrainedLostResponseRetryMs: retryElapsedMs },
    proxy: metrics,
    testDriverRssBytes: process.memoryUsage().rss,
  }));
});
