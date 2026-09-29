import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { databaseUrl } = integrationTargets();
const codeHashSecret = process.env.OTP_CODE_HASH_SECRET ?? process.env.JWT_SECRET;
if (!codeHashSecret) throw new Error("JWT_SECRET or OTP_CODE_HASH_SECRET is required for OTP integration fixtures");

process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "isolated-test-auth-token";
process.env.TWILIO_VERIFY_SERVICE_SID = "VA00000000000000000000000000000000";
const { withDurableOtpOperation } = require("../src/auth/otpService") as typeof import("../src/auth/otpService");

async function createChallenge(phone: string, purpose: string, providerSid: string, state = "issued") {
  const id = randomUUID();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO otp_challenges
        (id,purpose,phone_normalized,code_hash,expires_at,last_sent_at,provider_request_id,provider,verification_state)
       VALUES($1,$2,$3,$4,now()+interval '5 minutes',now(),$5,'twilio_verify',$6)`,
      [id, purpose, phone, createHmac("sha256", codeHashSecret).update(`initial:${id}`).digest("hex"), providerSid, state],
    );
  } finally {
    await client.end();
  }
  return id;
}

async function challengeState(challengeId: string) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const challenge = await client.query("SELECT verification_state,used_at,code_hash FROM otp_challenges WHERE id=$1", [challengeId]);
    const authorization = await client.query("SELECT consumed_at,expires_at FROM otp_operation_authorizations WHERE challenge_id=$1", [challengeId]);
    return { challenge: challenge.rows[0], authorization: authorization.rows[0] };
  } finally {
    await client.end();
  }
}

function isCodeHash(challengeId: string, code: string, hash: string) {
  return createHmac("sha256", codeHashSecret).update(`${challengeId}:${code}`).digest("hex") === hash;
}

test("external OTP authorization is exact-SID bound, safely retryable, single-use, and fails closed", async () => {
  const originalFetch = globalThis.fetch;
  const phone = phoneIdentity(await randomTestPhone());
  const validCode = "620941";
  const verificationSid = `VE${"a".repeat(32)}`;
  const challengeId = await createChallenge(phone, "signup", verificationSid);
  let providerCalls = 0;
  globalThis.fetch = async (input, init) => {
    providerCalls += 1;
    const url = String(input);
    const body = new URLSearchParams(String(init?.body));
    assert.ok(url.includes(`/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`));
    assert.equal(body.get("VerificationSid"), verificationSid);
    assert.equal(body.has("To"), false);
    return body.get("Code") === validCode
      ? new Response(JSON.stringify({ status: "approved" }), { status: 200 })
      : new Response("not found", { status: 404 });
  };

  const proof = { challengeId, phone, purpose: "signup", code: validCode };
  try {
    await assert.rejects(
      withDurableOtpOperation([proof], "register", null, async () => {
        throw new Error("forced account transaction rollback");
      }),
      /forced account transaction rollback/,
    );
    const authorized = await challengeState(challengeId);
    assert.equal(authorized.challenge.verification_state, "authorized");
    assert.equal(authorized.authorization.consumed_at, null);
    assert.ok(isCodeHash(challengeId, validCode, authorized.challenge.code_hash));

    await assert.rejects(
      withDurableOtpOperation([{ ...proof, code: "111111" }], "register", null, async () => "must not run"),
      (error: { code?: string }) => error.code === "OTP_INVALID",
    );
    assert.equal(providerCalls, 1, "an arbitrary six-digit retry must not reach the account operation or provider");

    const concurrent = await Promise.allSettled([
      withDurableOtpOperation([proof], "register", null, async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "completed";
      }),
      withDurableOtpOperation([proof], "register", null, async () => "duplicate"),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
    const used = await challengeState(challengeId);
    assert.equal(used.challenge.verification_state, "used");
    assert.ok(used.challenge.used_at);
    assert.ok(used.authorization.consumed_at);
    assert.equal(providerCalls, 1);
    await assert.rejects(
      withDurableOtpOperation([proof], "register", null, async () => "replay"),
      (error: { code?: string }) => error.code === "OTP_ALREADY_USED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const interrupted = await createChallenge(phone, "signup", `VE${"b".repeat(32)}`, "checking");
  await assert.rejects(
    withDurableOtpOperation([{ challengeId: interrupted, phone, purpose: "signup", code: validCode }], "register", null, async () => "must not run"),
    (error: { code?: string }) => error.code === "OTP_PROVIDER_AMBIGUOUS",
  );
  assert.equal(providerCalls, 1, "a restarted checking challenge must not repeat an ambiguous provider request");

  const failedPersistenceSid = `VE${"c".repeat(32)}`;
  const failedPersistenceId = await createChallenge(phone, "signup", failedPersistenceSid);
  const fixture = randomUUID().replace(/-/g, "");
  const functionName = `test_otp_authorization_failure_${fixture}`;
  const triggerName = `test_otp_authorization_failure_${fixture}`;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let providerCallsAfter = providerCalls;
  try {
    await client.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.challenge_id = '${failedPersistenceId}'::uuid THEN
          RAISE EXCEPTION 'intentional isolated authorization persistence failure';
        END IF;
        RETURN NEW;
      END;
    $$`);
    await client.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON otp_operation_authorizations FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);

    globalThis.fetch = async (_input, init) => {
      providerCalls += 1;
      assert.equal(new URLSearchParams(String(init?.body)).get("VerificationSid"), failedPersistenceSid);
      return new Response(JSON.stringify({ status: "approved" }), { status: 200 });
    };
    await assert.rejects(
      withDurableOtpOperation([{ challengeId: failedPersistenceId, phone, purpose: "signup", code: validCode }], "register", null, async () => "must not run"),
      (error: { code?: string; retryable?: boolean }) =>
        error.code === "OTP_AUTHORIZATION_PERSISTENCE_FAILED" && error.retryable === true,
    );
    const failedState = await client.query("SELECT verification_state FROM otp_challenges WHERE id=$1", [failedPersistenceId]);
    assert.equal(failedState.rows[0].verification_state, "checking");
    providerCallsAfter = providerCalls;
  } finally {
    await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON otp_operation_authorizations`).catch(() => undefined);
    await client.query(`DROP FUNCTION IF EXISTS ${functionName}()`).catch(() => undefined);
    await client.end();
    globalThis.fetch = originalFetch;
  }
  await assert.rejects(
    withDurableOtpOperation([{ challengeId: failedPersistenceId, phone, purpose: "signup", code: validCode }], "register", null, async () => "must not run"),
    (error: { code?: string }) => error.code === "OTP_PROVIDER_AMBIGUOUS",
  );
  assert.equal(providerCalls, providerCallsAfter);
});
