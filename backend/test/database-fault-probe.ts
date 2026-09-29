import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { randomTestPhone } from "./testPhone";
import { integrationTargets } from "./integrationTarget";

const phase = process.argv[2];
const { base } = integrationTargets();
const statePath = process.env.PHONEMAIL_FAULT_STATE;
if (!statePath) throw new Error("Database fault probe requires a disposable state-file path");

type State = { userId: string; phone: string; token: string; outagePhone: string };

async function prepare() {
  const [phone, outagePhone] = await Promise.all([randomTestPhone(), randomTestPhone()]);
  const response = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const session = JSON.parse(text) as { user: { id: string }; token: string };
  await writeFile(statePath, JSON.stringify({ userId: session.user.id, phone, token: session.token, outagePhone } satisfies State), { flag: "wx" });
  console.log("Prepared an isolated authenticated account for the database fault probe.");
}

async function main() {
  if (phase === "outage") {
    const state = JSON.parse(await readFile(statePath, "utf8")) as State;
    const [live, ready, login, storage, registration] = await Promise.all([
      fetch(`${base}/live`),
      fetch(`${base}/ready`),
      fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: state.phone, password: "StrongPass!123" }),
      }),
      fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${state.token}` } }),
      fetch(`${base}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: state.outagePhone, password: "StrongPass!123", termsAccepted: true }),
      }),
    ]);
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    assert.equal(login.status, 503);
    assert.equal(storage.status, 503);
    assert.equal(registration.status, 503);
    const bodies = await Promise.all([login.json(), storage.json(), registration.json()]) as { error: { code: string; retryable: boolean } }[];
    assert.ok(bodies.every(({ error }) => error.code === "SERVICE_UNAVAILABLE" && error.retryable));
    assert.equal(login.headers.get("retry-after"), "5");
    assert.ok(!JSON.stringify(bodies).includes("StrongPass!123") && !JSON.stringify(bodies).includes(state.token));
    console.log("Database outage: liveness 200; readiness/login/authenticated reads/registration retryable 503; diagnostics redacted");
    return;
  }

  if (phase === "recovered") {
    const state = JSON.parse(await readFile(statePath, "utf8")) as State;
    const { query } = await import("../src/db");
    assert.equal((await query("SELECT 1 FROM users WHERE phone_normalized=$1", [state.outagePhone!.replace(/^\+/, "")])).rowCount, 0);
    const authenticated = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${state.token}` } });
    assert.equal(authenticated.status, 200, await authenticated.text());
    const phone = await randomTestPhone();
    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, password: "StrongPass!123", termsAccepted: true }),
    });
    const registrationBody = await registration.text();
    assert.equal(registration.status, 201, registrationBody);
    const session = JSON.parse(registrationBody) as { token: string };
    const profile = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    assert.equal(profile.status, 200);
    console.log("Database recovery: pre-outage account and a new account authenticated successfully");
    return;
  }

  if (phase === "cleanup") {
    const state = JSON.parse(await readFile(statePath, "utf8")) as State;
    const { query } = await import("../src/db");
    try {
      await query("DELETE FROM users WHERE id=$1", [state.userId]);
    } finally {
      await unlink(statePath);
    }
    return;
  }

  throw new Error("Expected phase 'prepare', 'outage', 'recovered', or 'cleanup'");
}

const run = phase === "prepare" ? prepare : main;
run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database fault probe failed");
  process.exitCode = 1;
});
