import assert from "node:assert/strict";
import test from "node:test";
import QRCode from "qrcode";
import { simpleParser } from "mailparser";
import {
  compareQrIdentity,
  createIdentity,
  decryptMime,
  encryptMime,
  extractPgpMimeCiphertext,
  importIdentity,
  makeQrPayload,
  readQrPayload,
  signChallenge,
  wrapPgpMime,
} from "@phonemail/e2ee-client";

const passphrase = "two-browser-context-test-passphrase";
const aliceId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";

test("OpenPGP signed encryption, private-key passphrases, PGP/MIME attachments and QR trust", { timeout: 60_000 }, async () => {
  const [alice, bob] = await Promise.all([
    createIdentity(aliceId, passphrase),
    createIdentity(bobId, passphrase),
  ]);
  const importedAlice = await importIdentity(aliceId, alice.encryptedPrivateKey, passphrase);
  assert.equal(importedAlice.fingerprint, alice.fingerprint);
  await assert.rejects(importIdentity(bobId, alice.encryptedPrivateKey, passphrase));
  assert.notEqual(alice.encryptedPrivateKey, alice.publicKey);
  assert.match(alice.encryptedPrivateKey, /-----BEGIN PGP PRIVATE KEY BLOCK-----/);
  assert.match(await signChallenge(alice, passphrase, "PhoneMail challenge"), /-----BEGIN PGP SIGNATURE-----/);

  const attachment = new File([new Uint8Array([0, 1, 2, 255])], "payload.bin", { type: "application/octet-stream" });
  const encrypted = await encryptMime([alice, bob], passphrase, {
    subject: "Private subject",
    text: "Private body contents",
    attachments: [attachment],
  });
  assert.match(encrypted.ciphertext, /-----BEGIN PGP MESSAGE-----/);
  assert.match(encrypted.pgpMime, /multipart\/encrypted/);
  assert.equal(extractPgpMimeCiphertext(encrypted.pgpMime), encrypted.ciphertext);
  const parsedMime = await simpleParser(Buffer.from(encrypted.pgpMime));
  const outerContentType = parsedMime.headers.get("content-type");
  assert.ok(outerContentType && typeof outerContentType === "object" && "value" in outerContentType);
  assert.equal(outerContentType.value, "multipart/encrypted");
  const encryptedPart = parsedMime.attachments.find((part) => part.filename === "encrypted.asc");
  assert.ok(encryptedPart);
  const parsedCiphertext = encryptedPart.content.toString("utf8").trimEnd();
  assert.equal(parsedCiphertext, encrypted.ciphertext);
  assert.ok(!encrypted.ciphertext.includes("Private subject"));
  assert.ok(!encrypted.ciphertext.includes("payload.bin"));

  const plaintext = await decryptMime(bob, passphrase, encrypted.pgpMime, alice);
  assert.equal(await decryptMime(bob, passphrase, encrypted.ciphertext, alice), plaintext);
  const decryptedMime = await simpleParser(Buffer.from(plaintext));
  assert.equal(decryptedMime.subject, "Private subject");
  assert.equal(decryptedMime.text, "Private body contents");
  assert.equal(decryptedMime.attachments.length, 1);
  assert.equal(decryptedMime.attachments[0].filename, "payload.bin");
  assert.deepEqual(decryptedMime.attachments[0].content, Buffer.from([0, 1, 2, 255]));
  await assert.rejects(decryptMime(bob, "wrong-passphrase", encrypted.pgpMime, alice));
  const corrupted = encrypted.ciphertext.replace(/\n\n([A-Za-z0-9])/, (_match: string, byte: string) =>
    `\n\n${byte === "A" ? "B" : "A"}`);
  await assert.rejects(decryptMime(bob, passphrase, wrapPgpMime(corrupted), alice));

  const qr = await makeQrPayload(bob, "9876543210@phonemail.com");
  assert.match(await QRCode.toString(qr, { type: "svg" }), /<svg/);
  const identity = await readQrPayload(qr);
  assert.equal(identity.userId, bobId);
  assert.equal(identity.address, "9876543210@phonemail.com");
  const qrFields = JSON.parse(Buffer.from(qr.split(":").at(-1)!, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(qrFields).sort(), ["address", "fingerprint", "userId", "version"]);
  assert.equal(Object.values(qrFields).some((value) =>
    typeof value === "string" && (value.includes("BEGIN PGP") || /^https?:/i.test(value))), false);
  assert.deepEqual(compareQrIdentity(identity, bob.fingerprint), { status: "fingerprint-matches", matches: true });
  assert.deepEqual(compareQrIdentity(identity, alice.fingerprint), { status: "fingerprint-mismatch", matches: false });
  assert.deepEqual(compareQrIdentity(identity), { status: "first-use-unverified", matches: false });
  await assert.rejects(readQrPayload(`${qr}x`));
  await assert.rejects(readQrPayload("PHONEMAIL:E2EE:1:eyJ2ZXJzaW9uIjoxLCJleHRyYSI6dHJ1ZX0"));
  const forbidden = Buffer.from(JSON.stringify({
    version: 1,
    userId: bobId,
    fingerprint: bob.fingerprint,
    accessToken: "not-allowed",
  })).toString("base64url");
  await assert.rejects(readQrPayload(`PHONEMAIL:E2EE:1:${forbidden}`));
  await assert.rejects(readQrPayload("PHONEMAIL:E2EE:2:e30"));
  await assert.rejects(Promise.resolve().then(() => extractPgpMimeCiphertext("not MIME")));
  assert.match(wrapPgpMime(encrypted.ciphertext), /application\/pgp-encrypted/);
});
