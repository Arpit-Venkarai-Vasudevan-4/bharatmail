import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Client } from "pg";
import test from "node:test";
import { config } from "../src/config";
import { authRateLimit } from "../src/auth/rateLimit";
import { integrationTargets } from "./integrationTarget";
import { phoneIdentity, randomTestPhone } from "./testPhone";

const { databaseUrl } = integrationTargets();

function key(kind: "phone" | "ip", value: string) {
  return createHmac("sha256", config.otp.codeHashSecret || config.jwtSecret)
    .update(`auth-rate-limit:${kind}:${value}`)
    .digest("hex");
}

async function runLimit(phone: string, ip: string) {
  const req = { body: { phone }, ip } as Request;
  const headers: Record<string, string> = {};
  const res = {
    setHeader(name: string, value: string | number) {
      headers[name] = String(value);
      return this;
    },
  } as unknown as Response;
  return new Promise<{ error: unknown; headers: Record<string, string> }>((resolve, reject) => {
    const next = ((error?: unknown) => resolve({ error, headers })) as NextFunction;
    void authRateLimit(req, res, next).catch(reject);
  });
}

test("authentication throttles are database-shared, phone-canonical, and return Retry-After", async (t) => {
  const phone = await randomTestPhone();
  const digits = phoneIdentity(phone);
  const formatted = `+${digits.slice(0, 2)} (${digits.slice(2, 6)}) ${digits.slice(6)}`;
  const ips = Array.from({ length: 31 }, (_, index) => `198.51.100.${index + 1}`);
  const phoneKey = key("phone", digits);
  const invalidPhoneKey = key("phone", "invalid");
  const keys = [phoneKey, invalidPhoneKey, ...ips.map((ip) => key("ip", ip))];
  t.after(async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("DELETE FROM auth_rate_limits WHERE bucket_key=ANY($1::text[])", [keys]);
    } finally {
      await client.end();
    }
  });
  const setup = new Client({ connectionString: databaseUrl });
  await setup.connect();
  try {
    await setup.query("DELETE FROM auth_rate_limits WHERE bucket_key=ANY($1::text[])", [keys]);
  } finally {
    await setup.end();
  }

  const results = await Promise.all(ips.map((ip, index) => runLimit(index % 2 ? phone : formatted, ip)));
  assert.equal(results.filter((result) => !result.error).length, 30);
  const blocked = results.find((result) => result.error);
  assert.ok(blocked);
  assert.equal((blocked.error as { status?: number }).status, 429);
  const retryAfter = Number(blocked.headers["Retry-After"]);
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 15 * 60);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const persisted = await client.query<{ request_count: number }>(
      "SELECT request_count FROM auth_rate_limits WHERE bucket_key=$1",
      [phoneKey],
    );
    assert.equal(persisted.rows[0].request_count, 30);

    const invalidPhoneResults = await Promise.all(
      ips.map((ip, index) => runLimit(`unbounded-invalid-${index}`, ip)),
    );
    assert.equal(invalidPhoneResults.filter((result) => !result.error).length, 30);
    assert.ok(invalidPhoneResults.some((result) => result.error && (result.error as { status?: number }).status === 429));
    const invalidBucket = await client.query<{ request_count: number }>(
      "SELECT request_count FROM auth_rate_limits WHERE bucket_key=$1",
      [invalidPhoneKey],
    );
    assert.equal(invalidBucket.rows[0].request_count, 30);
  } finally {
    await client.end();
  }
});
