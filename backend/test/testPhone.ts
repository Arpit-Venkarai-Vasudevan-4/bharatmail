import { randomInt } from "node:crypto";
import { parsePhone } from "../src/phone";

type AllocatorOptions = {
  candidate?: () => string;
  isAvailable?: (e164: string, normalized: string, address: string) => Promise<boolean>;
  maxAttempts?: number;
};

export function createTestPhoneAllocator(options: AllocatorOptions = {}): () => Promise<string> {
  const used = new Set<string>();
  const candidate = options.candidate ?? (() => `+447911${String(randomInt(0, 1_000_000)).padStart(6, "0")}`);
  const isAvailable = options.isAvailable ?? (async (e164, normalized, address) => {
    const { query } = await import("../src/db");
    const result = await query<{ available: boolean }>(
      `SELECT NOT (
         EXISTS (SELECT 1 FROM users WHERE phone_normalized=$1 OR phone_e164=$2)
         OR EXISTS (SELECT 1 FROM phone_history WHERE phone_normalized=$1 OR phone_e164=$2 OR address=$3)
         OR EXISTS (SELECT 1 FROM addresses WHERE email=$3)
       ) AS available`,
      [normalized, e164, address],
    );
    return result.rows[0]?.available === true;
  });
  const maxAttempts = options.maxAttempts ?? 32;

  return async () => {
    let invalidCandidates = 0;
    let duplicateCandidates = 0;
    let retainedIdentityCollisions = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const value = candidate();
      let parsed: ReturnType<typeof parsePhone>;
      try {
        parsed = parsePhone(value);
      } catch {
        invalidCandidates += 1;
        continue;
      }
      if (used.has(parsed.e164)) {
        duplicateCandidates += 1;
        continue;
      }
      used.add(parsed.e164);
      const address = `${parsed.normalized}@phonemail.com`;
      if (!(await isAvailable(parsed.e164, parsed.normalized, address))) {
        used.delete(parsed.e164);
        retainedIdentityCollisions += 1;
        continue;
      }
      return parsed.e164;
    }
    throw new Error(
      `Could not allocate an unused valid test phone after ${maxAttempts} attempts ` +
      `(invalid=${invalidCandidates}, duplicate=${duplicateCandidates}, retainedCollision=${retainedIdentityCollisions})`,
    );
  };
}

const allocate = createTestPhoneAllocator();

export function randomTestPhone(): Promise<string> {
  return allocate();
}

export function phoneIdentity(phone: string): string {
  return phone.replace(/\D/g, "");
}
