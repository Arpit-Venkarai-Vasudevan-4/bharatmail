import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { query } from "../src/db";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();

async function call(path: string, init: RequestInit = {}, token?: string) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

async function register(phone: string) {
  const result = await call("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body as { user: { id: string }; token: string };
}

test("security audit events and durable notifications are owner-scoped, bounded, and transactional", async (t) => {
  const ownerPhone = await randomTestPhone();
  const otherPhone = await randomTestPhone();
  const owner = await register(ownerPhone);
  const other = await register(otherPhone);
  const ddl = new Client({ connectionString: databaseUrl });
  const suffix = randomUUID().replace(/-/g, "");
  const functionName = `test_reject_security_event_${suffix}`;
  const triggerName = `test_reject_security_event_${suffix}`;
  const notificationFunction = `test_reject_security_notification_${suffix}`;
  const notificationTrigger = `test_reject_security_notification_${suffix}`;
  t.after(async () => {
    try {
      await ddl.query(`DROP TRIGGER IF EXISTS ${triggerName} ON account_audit_events`);
      await ddl.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await ddl.query(`DROP TRIGGER IF EXISTS ${notificationTrigger} ON security_notifications`);
      await ddl.query(`DROP FUNCTION IF EXISTS ${notificationFunction}()`);
      await query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[owner.user.id, other.user.id]]);
    } finally {
      await ddl.end();
    }
  });
  await ddl.connect();

  const successfulLogin = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: ownerPhone, password: "StrongPass!123" }),
  });
  assert.equal(successfulLogin.response.status, 200, JSON.stringify(successfulLogin.body));
  const loginToken = successfulLogin.body.token as string;

  const wrongPassword = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: ownerPhone, password: "incorrect-password" }),
  });
  const unknownAccount = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "incorrect-password" }),
  });
  assert.equal(wrongPassword.response.status, 401);
  assert.equal(unknownAccount.response.status, 401);
  assert.deepEqual(wrongPassword.body.error, {
    ...unknownAccount.body.error,
    requestId: wrongPassword.body.error.requestId,
  });
  assert.equal(wrongPassword.body.error.code, unknownAccount.body.error.code);
  assert.equal(wrongPassword.body.error.message, unknownAccount.body.error.message);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await call("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: ownerPhone, password: "incorrect-password" }),
    });
  }
  const failedEventCount = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM account_audit_events WHERE user_id=$1 AND event_type='authentication_failed'",
    [owner.user.id],
  );
  assert.equal(failedEventCount.rows[0].count, 1);
  const failedNoticeCount = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM security_notifications WHERE user_id=$1 AND event_type='authentication_failed'",
    [owner.user.id],
  );
  assert.equal(failedNoticeCount.rows[0].count, 1);

  const createdAlias = await call("/api/me/addresses", {
    method: "POST",
    body: JSON.stringify({ alias: `secure${suffix.slice(0, 8)}` }),
  }, owner.token);
  assert.equal(createdAlias.response.status, 201, JSON.stringify(createdAlias.body));
  const aliasId = createdAlias.body.address.id as string;
  assert.equal((await call(`/api/me/addresses/${aliasId}`, {
    method: "PATCH",
    body: JSON.stringify({ active: false }),
  }, owner.token)).response.status, 200);
  assert.equal((await call("/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({ discoverable: false, readReceipts: false }),
  }, owner.token)).response.status, 200);

  const conversation = await call("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ participantPhones: [otherPhone] }),
  }, owner.token);
  assert.equal(conversation.response.status, 201, JSON.stringify(conversation.body));
  const conversationId = conversation.body.conversation.id as string;
  const message = await call(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ subject: "Audit test", body: "Must not appear in audit metadata." }),
  }, owner.token);
  assert.equal(message.response.status, 201, JSON.stringify(message.body));
  const messageId = message.body.message.id as string;
  assert.equal((await call(`/api/conversations/${conversationId}/messages/${messageId}/state`, {
    method: "PATCH",
    body: JSON.stringify({ folder: "trash" }),
  }, owner.token)).response.status, 204);

  const events = await call("/api/me/security-events?limit=50", {}, owner.token);
  assert.equal(events.response.status, 200, JSON.stringify(events.body));
  const aliasEmail = createdAlias.body.address.email as string;
  assert.equal(JSON.stringify(events.body.events).includes(aliasEmail), false);
  const aliasAuditPayloads = await query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM account_audit_events
      WHERE user_id=$1 AND event_type IN ('alias_created','alias_activation_changed')`,
    [owner.user.id],
  );
  assert.ok(aliasAuditPayloads.rows.length >= 2);
  assert.equal(JSON.stringify(aliasAuditPayloads.rows).includes(aliasEmail), false);
  const ownerTypes = events.body.events.map((event: { eventType: string }) => event.eventType);
  for (const eventType of [
    "account_created", "login_succeeded", "authentication_failed",
    "alias_created", "alias_activation_changed", "privacy_settings_changed",
  ]) {
    assert.ok(ownerTypes.includes(eventType), `missing durable notification ${eventType}`);
  }
  const otherEvents = await call("/api/me/security-events?limit=50", {}, other.token);
  assert.equal(otherEvents.response.status, 200);
  assert.ok(otherEvents.body.events.every((event: { id: string }) =>
    event.id !== events.body.events.find((candidate: { eventType: string }) => candidate.eventType === "login_succeeded")?.id));
  const ownerLoginNotification = events.body.events.find((event: { eventType: string }) => event.eventType === "login_succeeded");
  const crossAccountRead = await call(`/api/me/security-events/${ownerLoginNotification.id}/read`, {
    method: "PATCH",
  }, other.token);
  assert.equal(crossAccountRead.response.status, 404);
  assert.equal((await call(`/api/me/security-events/${ownerLoginNotification.id}/read`, {
    method: "PATCH",
  }, owner.token)).response.status, 204);
  const deletedMessageEvent = await query<{ count: number; payload: Record<string, unknown> }>(
    `SELECT count(*)::int AS count,(array_agg(payload))[1] AS payload
       FROM account_audit_events WHERE user_id=$1 AND event_type='message_deleted'`,
    [owner.user.id],
  );
  assert.equal(deletedMessageEvent.rows[0].count, 1);
  assert.deepEqual(deletedMessageEvent.rows[0].payload, { resourceId: messageId });

  await ddl.query(`
    CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = '${owner.user.id}'::uuid AND NEW.event_type = 'login_succeeded' THEN
        RAISE EXCEPTION 'synthetic audit transaction failure' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${triggerName} BEFORE INSERT ON account_audit_events
      FOR EACH ROW EXECUTE FUNCTION ${functionName}();
  `);
  const beforeFailedTransactionalLogin = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM account_audit_events WHERE user_id=$1 AND event_type='login_succeeded'",
    [owner.user.id],
  );
  const rolledBackLogin = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: ownerPhone, password: "StrongPass!123" }),
  });
  assert.equal(rolledBackLogin.response.status, 500);
  assert.doesNotMatch(JSON.stringify(rolledBackLogin.body), /synthetic audit transaction failure|StrongPass/);
  await ddl.query(`DROP TRIGGER ${triggerName} ON account_audit_events`);
  await ddl.query(`DROP FUNCTION ${functionName}()`);
  const afterFailedTransactionalLogin = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM account_audit_events WHERE user_id=$1 AND event_type='login_succeeded'",
    [owner.user.id],
  );
  assert.equal(afterFailedTransactionalLogin.rows[0].count, beforeFailedTransactionalLogin.rows[0].count);

  await ddl.query(`
    CREATE FUNCTION ${notificationFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.user_id = '${owner.user.id}'::uuid AND NEW.event_type = 'login_succeeded' THEN
        RAISE EXCEPTION 'synthetic notification transaction failure' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ${notificationTrigger} BEFORE INSERT ON security_notifications
      FOR EACH ROW EXECUTE FUNCTION ${notificationFunction}();
  `);
  const sessionCountBeforeNotificationFailure = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM sessions WHERE user_id=$1",
    [owner.user.id],
  );
  const failedNotificationLogin = await call("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: ownerPhone, password: "StrongPass!123" }),
  });
  assert.equal(failedNotificationLogin.response.status, 500);
  assert.doesNotMatch(JSON.stringify(failedNotificationLogin.body), /synthetic notification transaction failure|StrongPass/);
  await ddl.query(`DROP TRIGGER ${notificationTrigger} ON security_notifications`);
  await ddl.query(`DROP FUNCTION ${notificationFunction}()`);
  const sessionCountAfterNotificationFailure = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM sessions WHERE user_id=$1",
    [owner.user.id],
  );
  assert.equal(sessionCountAfterNotificationFailure.rows[0].count, sessionCountBeforeNotificationFailure.rows[0].count);

  const logout = await call("/api/auth/logout", { method: "POST" }, loginToken);
  assert.equal(logout.response.status, 204);
  const eventTypes = await query<{ event_type: string }>(
    "SELECT event_type FROM account_audit_events WHERE user_id=$1",
    [owner.user.id],
  );
  assert.ok(eventTypes.rows.some((event) => event.event_type === "logout"));
  assert.ok(eventTypes.rows.some((event) => event.event_type === "message_deleted"));
  const safePayloads = await query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM account_audit_events WHERE user_id=$1",
    [owner.user.id],
  );
  assert.doesNotMatch(JSON.stringify(safePayloads.rows), /StrongPass|incorrect-password|refreshToken|otp|codeHash/i);
});
