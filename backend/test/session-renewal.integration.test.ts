import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import test from "node:test";
import { integrationTargets } from "./integrationTarget";
import { randomTestPhone } from "./testPhone";

const { base } = integrationTargets();
const { query } = require("../src/db") as typeof import("../src/db");
async function request(path: string, init: RequestInit = {}, token?: string): Promise<{ response: Response; body: any }> {
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

async function register(_index: number, cookie = false) {
  const phone = await randomTestPhone();
  const { response, body } = await request("/api/auth/register", {
    method: "POST",
    headers: cookie ? { "X-Auth-Transport": "cookie" } : {},
    body: JSON.stringify({
      phone,
      password: "StrongPass!123",
      termsAccepted: true,
    }),
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return { response, body };
}

test("session refresh rotates atomically, retries lost responses, revokes replay, expiry, logout and cookie CSRF", async () => {
  const account = await register(1);
  const initialRefresh = account.body.refreshToken as string;
  assert.match(initialRefresh, /^[A-Za-z0-9_-]{43}$/);
  const accessClaims = jwt.decode(account.body.token) as { iat: number; exp: number };
  assert.equal(accessClaims.exp - accessClaims.iat, 15 * 60);
  const secondLogin = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: account.body.user.phoneE164, password: "StrongPass!123" }),
  });
  assert.equal(secondLogin.response.status, 200, JSON.stringify(secondLogin.body));

  const renewed = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: initialRefresh }),
  });
  assert.equal(renewed.response.status, 200, JSON.stringify(renewed.body));
  const nextRefresh = renewed.body.refreshToken as string;
  assert.notEqual(nextRefresh, initialRefresh);

  const secondRotation = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: nextRefresh }),
  });
  assert.equal(secondRotation.response.status, 200, JSON.stringify(secondRotation.body));
  assert.notEqual(secondRotation.body.refreshToken, nextRefresh);

  const retries = await Promise.all([
    request("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: initialRefresh }) }),
    request("/api/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken: initialRefresh }) }),
  ]);
  for (const retry of retries) {
    assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
    assert.deepEqual(retry.body, renewed.body);
  }

  const persisted = await query<{
    refresh_token_hash: string;
    previous_refresh_token_hash: string;
  }>(
    `SELECT s.refresh_token_hash,s.previous_refresh_token_hash
       FROM sessions s
       JOIN session_refresh_tokens rt ON rt.session_id=s.id
      WHERE rt.token_hash=$1`,
    [createHash("sha256").update(secondRotation.body.refreshToken).digest("hex")],
  );
  const currentHash = createHash("sha256").update(nextRefresh).digest("hex");
  const initialHash = createHash("sha256").update(initialRefresh).digest("hex");
  const finalHash = createHash("sha256").update(secondRotation.body.refreshToken).digest("hex");
  assert.equal(persisted.rows[0].refresh_token_hash, finalHash);
  assert.equal(persisted.rows[0].previous_refresh_token_hash, currentHash);
  const retryRecord = await query<{
    generation: number;
    used_at: Date | null;
    retry_until: Date | null;
    retry_ciphertext: string | null;
  }>(
    "SELECT generation,used_at,retry_until,retry_ciphertext FROM session_refresh_tokens WHERE token_hash=$1",
    [initialHash],
  );
  assert.equal(retryRecord.rows[0].generation, 0);
  assert.ok(retryRecord.rows[0].used_at);
  assert.ok(retryRecord.rows[0].retry_until);
  assert.ok(retryRecord.rows[0].retry_ciphertext);
  assert.ok(!retryRecord.rows[0].retry_ciphertext.includes(nextRefresh));

  await query(
    `UPDATE session_refresh_tokens SET retry_until=now()-interval '1 second'
      WHERE token_hash=$1`,
    [initialHash],
  );
  const replay = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: initialRefresh }),
  });
  assert.equal(replay.response.status, 401);
  assert.equal(replay.body.error.code, "SESSION_REUSE_DETECTED");
  const replayAudit = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM account_audit_events WHERE user_id=$1 AND event_type='credential_replay_detected'",
    [account.body.user.id],
  );
  assert.equal(replayAudit.rows[0].count, 1);
  const replayNotice = await query<{ count: number }>(
    "SELECT count(*)::int AS count FROM security_notifications WHERE user_id=$1 AND event_type='credential_replay_detected'",
    [account.body.user.id],
  );
  assert.equal(replayNotice.rows[0].count, 1);
  const invalidatedAccess = await request("/api/auth/me", {}, renewed.body.token);
  assert.equal(invalidatedAccess.response.status, 401);
  assert.equal((await request("/api/auth/me", {}, secondLogin.body.token)).response.status, 200);
  const independentRenewal = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: secondLogin.body.refreshToken }),
  });
  assert.equal(independentRenewal.response.status, 200);

  const expiring = await register(2);
  await query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [expiring.body.user.id]);
  const expired = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: expiring.body.refreshToken }),
  });
  assert.equal(expired.response.status, 401);
  assert.equal((await query("SELECT 1 FROM sessions WHERE user_id=$1", [expiring.body.user.id])).rowCount, 0);
  assert.equal((await query(
    "SELECT 1 FROM account_audit_events WHERE user_id=$1 AND event_type='credential_replay_detected'",
    [expiring.body.user.id],
  )).rowCount, 0, "ordinary session expiry must not be reported as a replay");

  const logoutAccount = await register(3);
  const logout = await request("/api/auth/logout", { method: "POST" }, logoutAccount.body.token);
  assert.equal(logout.response.status, 204);
  const afterLogout = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: logoutAccount.body.refreshToken }),
  });
  assert.equal(afterLogout.response.status, 401);

  const suspended = await register(5);
  await query("UPDATE users SET account_status='suspended' WHERE id=$1", [suspended.body.user.id]);
  const suspendedRefresh = await request("/api/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: suspended.body.refreshToken }),
  });
  assert.equal(suspendedRefresh.response.status, 401);
  await query("UPDATE users SET account_status='active' WHERE id=$1", [suspended.body.user.id]);

  const cookieAccount = await register(4, true);
  const setCookie = cookieAccount.response.headers.get("set-cookie") ?? "";
  const cookies = new Map<string, string>();
  for (const match of setCookie.matchAll(/(?:^|, )([^=;, ]+)=([^;,]*)/g)) cookies.set(match[1], match[2]);
  const sessionCookie = cookies.get("phonemail_session");
  const refreshCookie = cookies.get("phonemail_refresh");
  const csrfCookie = cookies.get("phonemail_csrf");
  assert.ok(sessionCookie && refreshCookie && csrfCookie);
  const cookieHeader = `phonemail_session=${sessionCookie}; phonemail_refresh=${refreshCookie}; phonemail_csrf=${csrfCookie}`;
  const noCsrf = await request("/api/auth/refresh", { method: "POST", headers: { cookie: cookieHeader } });
  assert.equal(noCsrf.response.status, 403);
  const cookieRenewal = await request("/api/auth/refresh", {
    method: "POST",
    headers: { cookie: cookieHeader, "x-csrf-token": csrfCookie },
  });
  assert.equal(cookieRenewal.response.status, 200, JSON.stringify(cookieRenewal.body));
  assert.deepEqual(Object.keys(cookieRenewal.body), ["user"]);

  const family = await query<{ family_id: string }>("SELECT family_id FROM sessions WHERE user_id=$1", [cookieAccount.body.user.id]);
  assert.equal(family.rowCount, 1);
});
