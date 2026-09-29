import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { base, databaseUrl } = integrationTargets();
const codeHashSecret = process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET;
if (!codeHashSecret) throw new Error("JWT_SECRET or OTP_CODE_HASH_SECRET is required for OTP integration fixtures");

async function request(path: string, body: unknown, token?: string) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  return { response, body: result };
}

async function register(phone: string) {
  return request("/api/auth/register", {
    phone,
    password: "StrongPass!123",
    termsAccepted: true,
  });
}

async function seedOtp(phone: string, purpose: string, code: string) {
  const id = randomUUID();
  const hash = createHmac("sha256", codeHashSecret).update(`${id}:${code}`).digest("hex");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO otp_challenges(id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider)
       VALUES($1,$2,$3,$4,now()+interval '5 minutes',now(),$5,'local_mock')`,
      [id, purpose, phoneIdentity(phone), hash, `local-${id}`],
    );
  } finally {
    await client.end();
  }
  return id;
}

test("phone reservations, registration authentication boundaries, and competing claims are atomic", async (t) => {
  const [retiredPhone, newPhone, passwordPhone, firstPhone, secondPhone, contestedNumber, retiringPhone, replacementPhone] =
    await Promise.all(Array.from({ length: 8 }, () => randomTestPhone()));
  const account = await register(retiredPhone);
  assert.equal(account.response.status, 201);

  const phoneChangeCode = "235781";
  const phoneChangeChallenge = await seedOtp(newPhone, "phone_change", phoneChangeCode);
  const changed = await request("/api/auth/phone-change", {
    currentPassword: "StrongPass!123",
    newPhone,
    challengeId: phoneChangeChallenge,
    code: phoneChangeCode,
  }, account.body.token);
  assert.equal(changed.response.status, 200);
  assert.equal(changed.body.user.id, account.body.user.id);
  assert.equal(changed.body.user.phone, phoneIdentity(newPhone));

  const client = new Client({ connectionString: databaseUrl });
  t.after(async () => client.end());
  await client.connect();
  const history = await client.query(
    "SELECT phone_normalized,address FROM phone_history WHERE user_id=$1 AND phone_normalized=$2",
    [account.body.user.id, phoneIdentity(retiredPhone)],
  );
  assert.equal(history.rowCount, 1);
  const identity = await client.query(
    "SELECT phone_normalized,phone_verified_at,phone_verification_provenance,terms_accepted_at,terms_version FROM users WHERE id=$1",
    [account.body.user.id],
  );
  assert.equal(identity.rows[0].phone_normalized, phoneIdentity(newPhone));
  assert.equal(identity.rows[0].phone_verified_at, null);
  assert.equal(identity.rows[0].phone_verification_provenance, "local_mock");
  assert.ok(identity.rows[0].terms_accepted_at);
  assert.equal(identity.rows[0].terms_version, "mvp-1");
  const retiredAddress = await client.query("SELECT 1 FROM addresses WHERE email=$1", [`${phoneIdentity(retiredPhone)}@phonemail.com`]);
  assert.equal(retiredAddress.rowCount, 0);

  const retiredDigits = phoneIdentity(retiredPhone);
  const formattedRetiredPhone = `+${retiredDigits.slice(0, 2)} (${retiredDigits.slice(2, 6)}) ${retiredDigits.slice(6)}`;
  const passwordReuse = await register(formattedRetiredPhone);
  assert.equal(passwordReuse.response.status, 409);
  assert.equal(passwordReuse.body.error.code, "PHONE_IN_USE");
  const retiredSignupCode = "482016";
  const retiredSignupChallenge = await seedOtp(retiredPhone, "signup", retiredSignupCode);
  const otpReuse = await request("/api/auth/otp/register", {
    phone: formattedRetiredPhone,
    challengeId: retiredSignupChallenge,
    code: retiredSignupCode,
    purpose: "signup",
    termsAccepted: true,
  });
  assert.equal(otpReuse.response.status, 409);
  const unusedProof = await client.query("SELECT used_at FROM otp_challenges WHERE id=$1", [retiredSignupChallenge]);
  assert.equal(unusedProof.rows[0].used_at, null);
  const retiredAlias = await request("/api/me/addresses", { alias: retiredPhone }, changed.body.token);
  assert.equal(retiredAlias.response.status, 400);
  const retiredRoute = await request("/api/conversations", { participantPhones: [retiredPhone] }, changed.body.token);
  assert.equal(retiredRoute.response.status, 404);
  const oldLookup = await request("/api/me/recipient-confirmation", { address: `${retiredDigits}@phonemail.com` }, changed.body.token);
  assert.equal(oldLookup.response.status, 200);
  assert.equal(oldLookup.body.available, false);

  const passwordAccount = await register(passwordPhone);
  assert.equal(passwordAccount.response.status, 201);
  const loginCode = "817304";
  const loginChallenge = await seedOtp(passwordAccount.body.user.phone, "login", loginCode);
  const otpTakeover = await request("/api/auth/otp/login", {
    phone: passwordAccount.body.user.phoneE164,
    challengeId: loginChallenge,
    code: loginCode,
    purpose: "login",
  });
  assert.equal(otpTakeover.response.status, 401);
  const takeoverProof = await client.query("SELECT used_at FROM otp_challenges WHERE id=$1", [loginChallenge]);
  assert.equal(takeoverProof.rows[0].used_at, null);
  const passwordLogin = await request("/api/auth/login", {
    phone: passwordAccount.body.user.phoneE164,
    password: "StrongPass!123",
  });
  assert.equal(passwordLogin.response.status, 200);

  const first = await register(firstPhone);
  const second = await register(secondPhone);
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);
  const firstCode = "371820";
  const secondCode = "693417";
  const firstChallenge = await seedOtp(contestedNumber, "phone_change", firstCode);
  const secondChallenge = await seedOtp(contestedNumber, "phone_change", secondCode);
  const claims = await Promise.all([
    request("/api/auth/phone-change", {
      currentPassword: "StrongPass!123",
      newPhone: contestedNumber,
      challengeId: firstChallenge,
      code: firstCode,
    }, first.body.token),
    request("/api/auth/phone-change", {
      currentPassword: "StrongPass!123",
      newPhone: contestedNumber,
      challengeId: secondChallenge,
      code: secondCode,
    }, second.body.token),
  ]);
  assert.equal(claims.filter((claim) => claim.response.status === 200).length, 1);
  assert.equal(claims.filter((claim) => claim.response.status === 409).length, 1);
  const uniqueClaim = await client.query("SELECT count(*)::int AS count FROM users WHERE phone_normalized=$1", [phoneIdentity(contestedNumber)]);
  assert.equal(uniqueClaim.rows[0].count, 1);

  const retiringAccount = await register(retiringPhone);
  assert.equal(retiringAccount.response.status, 201);
  const retirementCode = "806213";
  const retirementChallenge = await seedOtp(replacementPhone, "phone_change", retirementCode);
  const retirementRace = await Promise.all([
    request("/api/auth/phone-change", {
      currentPassword: "StrongPass!123",
      newPhone: replacementPhone,
      challengeId: retirementChallenge,
      code: retirementCode,
    }, retiringAccount.body.token),
    register(`+${phoneIdentity(retiringPhone).slice(0, 2)} ${phoneIdentity(retiringPhone).slice(2, 6)}-${phoneIdentity(retiringPhone).slice(6)}`),
  ]);
  assert.equal(retirementRace[0].response.status, 200);
  assert.equal(retirementRace[1].response.status, 409);
  const noReuse = await client.query(
    `SELECT
       (SELECT count(*)::int FROM phone_history WHERE phone_normalized=$1) AS retired,
       (SELECT count(*)::int FROM addresses WHERE email=$2) AS routed`,
    [phoneIdentity(retiringPhone), `${phoneIdentity(retiringPhone)}@phonemail.com`],
  );
  assert.equal(noReuse.rows[0].retired, 1);
  assert.equal(noReuse.rows[0].routed, 0);
});
