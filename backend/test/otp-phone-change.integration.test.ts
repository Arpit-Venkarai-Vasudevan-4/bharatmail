import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();
const secret = process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET ?? "test-secret";

async function request(path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  return { response, body: result };
}

async function phoneChangeRequest(body: unknown, token: string, idempotencyKey: string) {
  const response = await fetch(`${base}/api/auth/phone-change`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

function codeHash(id: string, code: string) {
  return createHmac("sha256", secret).update(`${id}:${code}`).digest("hex");
}

test("OTP-only phone change requires separate current and proposed-number proofs", async (t) => {
  const [oldPhone, newPhone] = await Promise.all([randomTestPhone(), randomTestPhone()]);
  const signupId = randomUUID();
  const signupCode = "426815";
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO otp_challenges (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES ($1,'signup',$2,$3,now()+interval '5 minutes',now(),$4,'local_mock')`,
      [signupId, phoneIdentity(oldPhone), codeHash(signupId, signupCode), `local-${signupId}`],
    );
  } finally {
    await client.end();
  }
  const signup = await request("/api/auth/otp/register", {
    phone: oldPhone, challengeId: signupId, code: signupCode, purpose: "signup", termsAccepted: true,
  });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.body.user.phone, phoneIdentity(oldPhone));

  const oldChallengeId = randomUUID();
  const newChallengeId = randomUUID();
  const oldCode = "891243";
  const newCode = "176502";
  const proofs = new Client({ connectionString: databaseUrl });
  await proofs.connect();
  try {
    await proofs.query(
      `INSERT INTO otp_challenges (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES ($1,'phone_change_old',$2,$3,now()+interval '5 minutes',now(),$4,'local_mock'),
             ($5,'phone_change',$6,$7,now()+interval '5 minutes',now(),$8,'local_mock')`,
      [
        oldChallengeId, phoneIdentity(oldPhone), codeHash(oldChallengeId, oldCode), `local-${oldChallengeId}`,
        newChallengeId, phoneIdentity(newPhone), codeHash(newChallengeId, newCode), `local-${newChallengeId}`,
      ],
    );
  } finally {
    await proofs.end();
  }

  const newNumberOnly = await request("/api/auth/phone-change", {
    newPhone, challengeId: newChallengeId, code: newCode,
  }, signup.body.token);
  assert.equal(newNumberOnly.response.status, 403);
  const stillOld = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${signup.body.token}` } });
  assert.equal((await stillOld.json() as any).user.phone, phoneIdentity(oldPhone));

  const changeBody = { newPhone, challengeId: newChallengeId, code: newCode, oldChallengeId, oldCode };
  const changeKey = `otp-phone-change-${randomUUID()}`;
  const changed = await phoneChangeRequest(changeBody, signup.body.token, changeKey);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.user.id, signup.body.user.id);
  assert.equal(changed.body.user.phone, phoneIdentity(newPhone));
  const recovered = await phoneChangeRequest(changeBody, signup.body.token, changeKey);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.token, changed.body.token);
  assert.deepEqual(recovered.body.user, changed.body.user);
  const conflictingRetry = await phoneChangeRequest(
    { ...changeBody, newPhone: `${newPhone}9` },
    signup.body.token,
    changeKey,
  );
  assert.equal(conflictingRetry.response.status, 409);
  const staleSession = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${signup.body.token}` } });
  assert.equal(staleSession.status, 401);
  const replay = await request("/api/auth/phone-change", {
    newPhone: `${newPhone}9`, challengeId: newChallengeId, code: newCode, oldChallengeId, oldCode,
  }, changed.body.token);
  assert.equal(replay.response.status, 400);
});
