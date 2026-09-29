import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();

async function request(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: ["Bearer", token].join(" ") } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "request failed"), { status: response.status, body });
  return body;
}

test("conversation list keyset pages filter before pagination and terminate without omissions", async (t) => {
  const phone = await randomTestPhone();
  const registered = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const ids: string[] = [];
  t.after(async () => {
    try {
      if (ids.length) await client.query("DELETE FROM conversations WHERE id = ANY($1::uuid[])", [ids]);
      await client.query("DELETE FROM users WHERE id = $1", [registered.user.id]);
    } finally {
      await client.end();
    }
  });
  const created = await client.query<{ id: string }>(
    "INSERT INTO conversations(kind) SELECT 'group' FROM generate_series(1, 137) RETURNING id",
  );
  ids.push(...created.rows.map((row) => row.id));
  await client.query(
    "INSERT INTO conversation_members(conversation_id,email,user_id) SELECT unnest($1::uuid[]),$2,$3",
    [ids, registered.user.email, registered.user.id],
  );
  const memberCount = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM conversation_members WHERE user_id=$1 AND conversation_id=ANY($2::uuid[])",
    [registered.user.id, ids],
  );
  assert.equal(memberCount.rows[0].count, "137");

  for (const limit of [1, 10, 50]) {
    const recovered: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({ limit: String(limit), filter: "all" });
      if (cursor) query.set("cursor", cursor);
      const page = await request(`/api/conversations?${query}`, {}, registered.token);
      pages += 1;
      assert.ok(pages <= Math.ceil(ids.length / limit) + 1, "pagination must terminate");
      recovered.push(...page.conversations.map((conversation: { id: string }) => conversation.id));
      assert.equal(page.hasMore, Boolean(page.nextCursor));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(recovered.length, ids.length, `limit=${limit}; recovered ${recovered.length}; pages=${pages}`);
    assert.equal(new Set(recovered).size, ids.length);
    assert.deepEqual(new Set(recovered), new Set(ids));
  }

  const first = await request("/api/conversations?limit=1&filter=all", {}, registered.token);
  const mismatched = await fetch(
    `${base}/api/conversations?limit=1&filter=unread&cursor=${encodeURIComponent(first.nextCursor)}`,
    { headers: { authorization: ["Bearer", registered.token].join(" ") } },
  );
  assert.equal(mismatched.status, 400);
});
