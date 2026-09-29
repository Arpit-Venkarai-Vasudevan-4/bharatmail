import assert from "node:assert/strict";
import test from "node:test";
import { integrationTargets } from "./integrationTarget";
import { query } from "../src/db";
import { randomTestPhone } from "./testPhone";

const { base } = integrationTargets();

async function request(path: string, init: RequestInit = {}, token?: string): Promise<any> {
  const headers = {
    "content-type": "application/json",
    ...(token ? { authorization: "Bearer " + token } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.message ?? "request failed"), { status: response.status, data });
  }
  return data;
}

test("contacts, recipient confirmation, blocking, profiles, and privacy are account-scoped", async () => {
  const a = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  const b = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  const c = await request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ phone: await randomTestPhone(), password: "StrongPass!123", termsAccepted: true }),
  });
  const contact = await request(
    "/api/me/contacts",
    { method: "POST", body: JSON.stringify({ address: `${b.user.phone}@phonemail.com`, label: "Trusted B" }) },
    a.token,
  );
  assert.equal(contact.contact.userId, b.user.id);
  assert.equal((await request("/api/me/contacts", {}, a.token)).contacts.length, 1);
  assert.equal(
    (await request("/api/me/recipient-confirmation", {
      method: "POST", body: JSON.stringify({ address: `${b.user.phone}@phonemail.com` }),
    }, a.token)).available,
    true,
  );
  await request("/api/me/blocks", { method: "POST", body: JSON.stringify({ userId: b.user.id }) }, a.token);
  await assert.rejects(
    request("/api/conversations", {
      method: "POST", body: JSON.stringify({ participantPhones: [b.user.phone] }),
    }, a.token),
    (error: any) => error.status === 403,
  );

  const avatarBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const avatar = await request("/api/uploads", {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-filename": "avatar.png",
      "x-expected-bytes": String(avatarBytes.byteLength),
    },
    body: avatarBytes,
  }, b.token);
  assert.equal(avatar.upload.status, "ready");
  await request("/api/me/profile-picture", {
    method: "PUT", body: JSON.stringify({ uploadId: avatar.upload.id }),
  }, b.token);
  const visiblePicture = await fetch(`${base}/api/users/${b.user.id}/profile-picture`, {
    headers: { authorization: "Bearer " + c.token },
  });
  assert.equal(visiblePicture.status, 200);
  assert.deepEqual(new Uint8Array(await visiblePicture.arrayBuffer()), avatarBytes);

  await request("/api/me/preferences", {
    method: "PATCH",
    body: JSON.stringify({
      discoverable: true,
      profileVisible: false,
      readReceipts: false,
      smsEnabled: false,
      ivrEnabled: false,
    }),
  }, b.token);
  const preferences = await request("/api/me/preferences", {}, b.token);
  assert.deepEqual(preferences.preferences, {
    sms_enabled: false,
    ivr_enabled: false,
    discoverable: true,
    profile_visible: false,
    read_receipts: false,
    communication_enabled: true,
  });
  await assert.rejects(
    request("/api/me/preferences", {
      method: "PATCH", body: JSON.stringify({ accountStatus: "disabled" }),
    }, b.token),
    (error: any) => error.status === 400,
  );
  await assert.rejects(
    request("/api/me/preferences", { method: "PATCH", body: JSON.stringify({}) }, b.token),
    (error: any) => error.status === 400,
  );

  const snapshot = await request("/api/sync/snapshot?limit=50", {}, b.token);
  const accountRecord = snapshot.records.find((record: any) => record.entity_type === "account");
  assert.deepEqual(accountRecord.payload.preferences, {
    smsEnabled: false,
    ivrEnabled: false,
    discoverable: true,
    profileVisible: false,
    readReceipts: false,
    communicationEnabled: true,
  });
  const incremental = await request("/api/sync?cursor=0&limit=100", {}, b.token);
  const preferenceChanges = incremental.changes.filter((change: any) => change.entity_type === "preferences");
  assert.ok(preferenceChanges.some((change: any) => change.payload.sms_enabled === false && change.payload.profile_visible === false));
  assert.ok(!JSON.stringify(preferenceChanges).includes("displayName"));

  const hiddenPicture = await fetch(`${base}/api/users/${b.user.id}/profile-picture`, {
    headers: { authorization: "Bearer " + c.token },
  });
  assert.equal(hiddenPicture.status, 404);
  const hiddenProfile = await request("/api/me/recipient-confirmation", {
    method: "POST", body: JSON.stringify({ address: `${b.user.phone}@phonemail.com` }),
  }, c.token);
  assert.equal(hiddenProfile.available, true);
  assert.equal(Object.prototype.hasOwnProperty.call(hiddenProfile, "displayName"), false);
  await request("/api/me/preferences", {
    method: "PATCH", body: JSON.stringify({ communicationEnabled: false }),
  }, b.token);
  await assert.rejects(
    request("/api/conversations", {
      method: "POST", body: JSON.stringify({ participantPhones: [b.user.phone] }),
    }, c.token),
    (error: any) => error.status === 403 && error.data.error.code === "RECIPIENT_UNAVAILABLE",
  );
  await request("/api/me/preferences", {
    method: "PATCH", body: JSON.stringify({ discoverable: false }),
  }, b.token);
  assert.equal((await request("/api/me/recipient-confirmation", {
    method: "POST", body: JSON.stringify({ address: `${b.user.phone}@phonemail.com` }),
  }, c.token)).available, false);

  await query("UPDATE users SET account_status='disabled' WHERE id=$1", [b.user.id]);
  const disabledProfile = await request("/api/me", {}, b.token).catch((error: any) => error);
  assert.equal(disabledProfile.status, 401);
  await assert.rejects(
    request("/api/conversations", {
      method: "POST", body: JSON.stringify({ participantPhones: [b.user.phone] }),
    }, c.token),
    (error: any) => error.status === 404,
  );
  await query("UPDATE users SET account_status='active' WHERE id=$1", [b.user.id]);
});
