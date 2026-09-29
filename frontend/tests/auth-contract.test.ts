import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, retryAfterMs } from '../src/lib/api';
import { retryAfter } from '../src/features/auth/contracts';
test('rate-limit headers and backend fields become a seconds-based UI cooldown', () => {
  assert.equal(retryAfterMs('60'), 60_000);
  const now = Date.UTC(2026, 8, 28, 12, 0, 0);
  assert.equal(retryAfterMs('Mon, 28 Sep 2026 12:00:20 GMT', now), 20_000);
  assert.equal(retryAfter(new ApiError(429, 'RATE_LIMITED', 'Wait', undefined, 60_000)), 60);
  assert.equal(retryAfter({ fields: { retryAfter: '30' } }), 30);
  assert.equal(retryAfterMs('not-a-date'), 0);
});
