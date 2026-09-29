import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import test from "node:test";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();

async function request(path: string, token: string, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function register(phone: string, displayName: string) {
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: "StrongPass!123", displayName, termsAccepted: true }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body as { token: string; user: { id: string; phone: string } };
}

async function createConversation(token: string, participant: string) {
  return request("/api/conversations", token, "POST", { participantPhones: [participant] });
}

async function waitForAdvisoryWaiters(client: Client, minimum: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted",
    );
    if (result.rows[0].count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${minimum} advisory-lock waiters`);
}

test("aliases preserve historical identity, block reuse, and retain direct grouping", async () => {
  const suffix = randomUUID().slice(0, 8);
  const [ownerPhone, senderPhone, thirdPhone] = await Promise.all([
    randomTestPhone(), randomTestPhone(), randomTestPhone(),
  ]);
  const owner = await register(ownerPhone, "Alias owner");
  const sender = await register(senderPhone, "Alias sender");
  const third = await register(thirdPhone, "Third account");
  const aliasName = `alias${suffix}`;
  const aliasEmail = `${aliasName}@phonemail.com`;

  const created = await request("/api/me/addresses", owner.token, "POST", { alias: aliasName });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const address = created.body.address as { id: string; email: string };
  assert.equal(address.email, aliasEmail);

  const disabled = await request(`/api/me/addresses/${address.id}`, owner.token, "PATCH", { active: false });
  assert.equal(disabled.response.status, 200);
  const unavailableAlias = await createConversation(sender.token, aliasEmail);
  assert.equal(unavailableAlias.response.status, 404);
  const reactivated = await request(`/api/me/addresses/${address.id}`, owner.token, "PATCH", { active: true });
  assert.equal(reactivated.response.status, 200);

  const byAlias = await createConversation(sender.token, aliasEmail);
  assert.equal(byAlias.response.status, 201, JSON.stringify(byAlias.body));
  const conversationId = byAlias.body.conversation.id as string;
  const firstMessage = await request(`/api/conversations/${conversationId}/messages`, sender.token, "POST", {
    subject: "Alias history",
    body: "This belongs to the account, not to a reusable alias string.",
  });
  assert.equal(firstMessage.response.status, 201, JSON.stringify(firstMessage.body));
  const messageId = firstMessage.body.message.id as string;

  const byPhone = await createConversation(sender.token, ownerPhone);
  assert.equal(byPhone.response.status, 201, JSON.stringify(byPhone.body));
  assert.equal(byPhone.body.conversation.id, conversationId);

  const deleted = await request(`/api/me/addresses/${address.id}`, owner.token, "DELETE");
  assert.equal(deleted.response.status, 204);
  const historicalMessage = await request(
    `/api/conversations/${conversationId}/messages/${messageId}`,
    owner.token,
  );
  assert.equal(historicalMessage.response.status, 200);
  assert.match(historicalMessage.body.message.body, /not to a reusable alias string/);

  const reply = await request(`/api/conversations/${conversationId}/messages`, owner.token, "POST", {
    body: "The original account can still reply after retiring its alias.",
    inReplyToId: messageId,
  });
  assert.equal(reply.response.status, 201, JSON.stringify(reply.body));
  assert.equal(reply.body.message.senderEmail, owner.user.email);

  const retiredAddressSend = await createConversation(sender.token, aliasEmail);
  assert.equal(retiredAddressSend.response.status, 404);
  const reuse = await request("/api/me/addresses", third.token, "POST", { alias: aliasName });
  assert.equal(reuse.response.status, 409);
  const privateHistory = await request(`/api/conversations/${conversationId}`, third.token);
  assert.equal(privateHistory.response.status, 404);

  const competingAlias = `race${suffix}`;
  const claims = await Promise.all([
    request("/api/me/addresses", owner.token, "POST", { alias: competingAlias }),
    request("/api/me/addresses", third.token, "POST", { alias: competingAlias }),
  ]);
  assert.deepEqual(claims.map((claim) => claim.response.status).sort(), [201, 409]);
  const winnerIndex = claims.findIndex((claim) => claim.response.status === 201);
  const winnerToken = winnerIndex === 0 ? owner.token : third.token;
  const loserToken = winnerIndex === 0 ? third.token : owner.token;
  const racedAliasId = claims[winnerIndex].body.address.id as string;
  const retireRace = await request(`/api/me/addresses/${racedAliasId}`, winnerToken, "DELETE");
  assert.equal(retireRace.response.status, 204);
  const retiredRaceReuse = await request("/api/me/addresses", loserToken, "POST", { alias: competingAlias });
  assert.equal(retiredRaceReuse.response.status, 409);

  const enabled = await request("/api/me/preferences", owner.token, "PATCH", { communicationEnabled: true });
  assert.equal(enabled.response.status, 200);
  const blocker = new Client({ connectionString: databaseUrl });
  await blocker.connect();
  await blocker.query("BEGIN");
  try {
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`phonemail.account_changes:${owner.user.id}`]);
    const preferenceChange = request("/api/me/preferences", owner.token, "PATCH", { communicationEnabled: false });
    await waitForAdvisoryWaiters(blocker, 1);
    const concurrentSend = request(`/api/conversations/${conversationId}/messages`, sender.token, "POST", {
      body: "Must be rejected after the locked preference change.",
    });
    await waitForAdvisoryWaiters(blocker, 2);
    await blocker.query("COMMIT");
    const [preferenceResult, sendResult] = await Promise.all([preferenceChange, concurrentSend]);
    assert.equal(preferenceResult.response.status, 200);
    assert.equal(sendResult.response.status, 403);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    await blocker.end();
  }

  const privilegedPatch = await request("/api/me", third.token, "PATCH", { accountStatus: "suspended" });
  assert.equal(privilegedPatch.response.status, 400);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const status of ["disabled", "suspended"]) {
      await client.query("UPDATE users SET account_status=$2 WHERE id=$1", [third.user.id, status]);
      const disabledSession = await request("/api/me", third.token);
      assert.equal(disabledSession.response.status, 401);
      const disabledAccountSend = await createConversation(sender.token, thirdPhone);
      assert.equal(disabledAccountSend.response.status, 404);
    }
  } finally {
    await client.query("UPDATE users SET account_status='active' WHERE id=$1", [third.user.id]);
    await client.end();
  }
});
