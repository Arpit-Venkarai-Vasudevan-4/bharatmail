import * as openpgp from "openpgp";

export type LocalIdentity = {
  userId: string;
  fingerprint: string;
  publicKey: string;
  encryptedPrivateKey: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_QR_LENGTH = 8_192;
const MAX_ATTACHMENT_BYTES = 9 * 1024 * 1024;
const PGP_BEGIN = "-----BEGIN PGP MESSAGE-----";
const PGP_END = "-----END PGP MESSAGE-----";

function assertUuid(value: string) {
  if (!UUID.test(value)) throw new Error("PhoneMail user identity must be a UUID");
}

export async function createIdentity(userId: string, passphrase: string): Promise<LocalIdentity> {
  assertUuid(userId);
  if (passphrase.length < 12) throw new Error("Use a passphrase of at least 12 characters");
  const generated = await openpgp.generateKey({
    type: "curve25519",
    userIDs: [{ name: "PhoneMail user", email: `${userId}@keys.phonemail.com` }],
    passphrase,
    format: "armored",
  });
  const key = await openpgp.readKey({ armoredKey: generated.publicKey });
  return {
    userId,
    fingerprint: key.getFingerprint().toUpperCase(),
    publicKey: generated.publicKey,
    encryptedPrivateKey: generated.privateKey,
  };
}

export async function importIdentity(userId: string, encryptedPrivateKey: string, passphrase: string): Promise<LocalIdentity> {
  assertUuid(userId);
  if (!encryptedPrivateKey.startsWith("-----BEGIN PGP PRIVATE KEY BLOCK-----") || encryptedPrivateKey.length > 32 * 1024) {
    throw new Error("Import a bounded ASCII-armored private key");
  }
  const privateKey = await openpgp.readPrivateKey({ armoredKey: encryptedPrivateKey });
  if (privateKey.isDecrypted()) throw new Error("Unprotected private keys cannot be imported");
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  if (!unlocked.getUserIDs().some((identity) => new RegExp(`(?:^|<)${userId}@keys\\.phonemail\\.com(?:>|$)`, "i").test(identity))) {
    throw new Error("Private key is not bound to this immutable PhoneMail user ID");
  }
  const publicKey = unlocked.toPublic().armor();
  const publicParsed = await openpgp.readKey({ armoredKey: publicKey });
  return {
    userId,
    fingerprint: publicParsed.getFingerprint().toUpperCase(),
    publicKey,
    encryptedPrivateKey,
  };
}

export async function signChallenge(identity: LocalIdentity, passphrase: string, challenge: string) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: identity.encryptedPrivateKey });
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  const message = await openpgp.createMessage({ text: challenge });
  return openpgp.sign({ message, signingKeys: unlocked, detached: true, format: "armored" });
}

export async function encryptMime(
  identities: LocalIdentity[],
  passphrase: string,
  message: { subject: string; text: string; attachments?: File[] },
) {
  assertRecipientIdentities(identities);
  const attachments = message.attachments ?? [];
  if (attachments.length > 10 || attachments.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
    throw new Error("At most 10 attachments of 9 MiB each are supported");
  }
  if (attachments.reduce((sum, file) => sum + file.size, 0) > 9 * 1024 * 1024) {
    throw new Error("Combined attachment size must not exceed 9 MiB");
  }
  const mime = await createInnerMime(message.subject, message.text, attachments);
  const encrypted = await encryptInnerMime(identities, passphrase, mime);
  return {
    ...encrypted,
    pgpMime: wrapPgpMime(encrypted.ciphertext),
  };
}

function assertRecipientIdentities(identities: LocalIdentity[]) {
  if (identities.length < 1 || identities.length > 50) throw new Error("Select 1 to 50 recipients");
  const userIds = identities.map((identity) => identity.userId.toLowerCase());
  if (new Set(userIds).size !== userIds.length) throw new Error("Recipient identities must be unique");
  for (const identity of identities) assertUuid(identity.userId);
}

export async function encryptInnerMime(
  identities: LocalIdentity[],
  passphrase: string,
  mime: string,
) {
  assertRecipientIdentities(identities);
  if (!mime || new TextEncoder().encode(mime).byteLength > 10 * 1024 * 1024) {
    throw new Error("Encrypted MIME content must be non-empty and under 10 MiB");
  }
  const privateKey = await openpgp.readPrivateKey({ armoredKey: identities[0].encryptedPrivateKey });
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  const keys = await Promise.all(identities.map((identity) => openpgp.readKey({ armoredKey: identity.publicKey })));
  const source = await openpgp.createMessage({ text: mime });
  const ciphertext = (await openpgp.encrypt({
    message: source,
    encryptionKeys: keys,
    signingKeys: unlocked,
    format: "armored",
  })).trimEnd();
  return {
    ciphertext,
    keyFingerprints: identities.map((identity) => identity.fingerprint.toUpperCase()).sort(),
  };
}

async function createInnerMime(subject: string, text: string, attachments: File[]) {
  if (/[\r\n\0]/.test(subject) || subject.length > 200 || text.length > 100_000) {
    throw new Error("Subject or message body is invalid");
  }
  const lines = [
    "MIME-Version: 1.0",
    `Subject: ${encodeHeader(subject)}`,
  ];
  if (!attachments.length) {
    return `${lines.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}`;
  }
  const boundary = `phonemail-${crypto.randomUUID()}`;
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}`,
  ];
  for (const file of attachments) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    parts.push(
      `--${boundary}\r\nContent-Type: ${safeMime(file.type)}; name="${encodeParameter(file.name)}"\r\n` +
      `Content-Disposition: attachment; filename="${encodeParameter(file.name)}"\r\n` +
      "Content-Transfer-Encoding: base64\r\n\r\n" + base64Lines(bytes),
    );
  }
  parts.push(`--${boundary}--`);
  return `${lines.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n`;
}

function encodeHeader(value: string) {
  const bytes = new TextEncoder().encode(value);
  if ([...bytes].every((byte) => byte >= 0x20 && byte < 0x7f)) return value;
  return `=?UTF-8?B?${bytesToBase64(bytes)}?=`;
}

function encodeParameter(value: string) {
  return value.replace(/[\r\n\0"]/g, "_").replace(/[^\x20-\x7e]/g, "_").slice(0, 120);
}

function safeMime(value: string) {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : "application/octet-stream";
}

function quotedPrintable(value: string) {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const bytes = new TextEncoder().encode(line);
    let encoded = "";
    let current = "";
    bytes.forEach((byte, index) => {
      const trailingSpace = index === bytes.length - 1 && (byte === 32 || byte === 9);
      const token = !trailingSpace && (byte === 9 || byte === 32 || byte >= 33 && byte <= 60 || byte >= 62 && byte <= 126)
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (current.length + token.length > 75) {
        encoded += `${current}=\r\n`;
        current = "";
      }
      current += token;
    });
    return `${encoded}${current}`;
  }).join("\r\n");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Lines(bytes: Uint8Array) {
  const encoded = bytesToBase64(bytes);
  return encoded.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

export function wrapPgpMime(ciphertext: string) {
  if (!ciphertext.startsWith(PGP_BEGIN) || !ciphertext.includes(PGP_END)) throw new Error("Invalid OpenPGP ciphertext");
  const boundary = `=_PhoneMail_${crypto.randomUUID()}`;
  return [
    "MIME-Version: 1.0",
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: application/pgp-encrypted",
    "Content-Description: PGP/MIME version identification",
    "",
    "Version: 1",
    `--${boundary}`,
    "Content-Type: application/octet-stream; name=encrypted.asc",
    "Content-Description: OpenPGP encrypted message",
    "Content-Disposition: inline; filename=encrypted.asc",
    "",
    ciphertext,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export function extractPgpMimeCiphertext(mime: string) {
  if (mime.length > 16 * 1024 * 1024) throw new Error("Unsupported or oversized PGP/MIME message");
  if (mime.startsWith(PGP_BEGIN)) {
    const end = mime.indexOf(PGP_END, PGP_BEGIN.length);
    if (end < 0) throw new Error("OpenPGP message footer is missing");
    return mime.slice(0, end + PGP_END.length);
  }
  if (!/^MIME-Version: 1\.0\r\nContent-Type: multipart\/encrypted;/i.test(mime)) {
    throw new Error("Unsupported or oversized PGP/MIME message");
  }
  const begin = mime.indexOf(PGP_BEGIN);
  const end = mime.indexOf(PGP_END, begin);
  if (begin < 0 || end < 0) throw new Error("PGP/MIME encrypted part is missing");
  return mime.slice(begin, end + PGP_END.length);
}

export async function decryptMime(
  identity: LocalIdentity,
  passphrase: string,
  ciphertext: string,
  signer: LocalIdentity | LocalIdentity[] = identity,
) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: identity.encryptedPrivateKey });
  const unlocked = await openpgp.decryptKey({ privateKey, passphrase });
  const message = await openpgp.readMessage({ armoredMessage: extractPgpMimeCiphertext(ciphertext) });
  const result = await openpgp.decrypt({
    message,
    decryptionKeys: unlocked,
    verificationKeys: await Promise.all(
      (Array.isArray(signer) ? signer : [signer]).map((item) => openpgp.readKey({ armoredKey: item.publicKey })),
    ),
    format: "utf8",
  });
  const signatureChecks = await Promise.all(result.signatures.map((signature) => signature.verified));
  if (!signatureChecks.length || signatureChecks.some((valid) => !valid)) throw new Error("Message signature is invalid");
  return String(result.data);
}

export type QrIdentity = {
  version: 1;
  userId: string;
  fingerprint: string;
  address?: string;
};

export async function makeQrPayload(identity: LocalIdentity, address?: string) {
  assertUuid(identity.userId);
  const key = await openpgp.readKey({ armoredKey: identity.publicKey });
  if (key.isPrivate() || key.getFingerprint().toUpperCase() !== identity.fingerprint.toUpperCase()) {
    throw new Error("The public key fingerprint does not match");
  }
  if (address && (!/^[0-9]{8,15}@phonemail\.com$/i.test(address) || /[\r\n]/.test(address))) {
    throw new Error("QR address must be a canonical PhoneMail address");
  }
  const payload: QrIdentity = {
    version: 1,
    userId: identity.userId,
    fingerprint: identity.fingerprint.toUpperCase(),
    ...(address ? { address } : {}),
  };
  const encoded = `PHONEMAIL:E2EE:1:${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
  if (encoded.length > MAX_QR_LENGTH) throw new Error("Identity QR payload exceeds 8 KiB");
  return encoded;
}

export async function readQrPayload(value: string): Promise<QrIdentity> {
  if (value.length > MAX_QR_LENGTH) throw new Error("Identity QR payload exceeds 8 KiB");
  const match = /^PHONEMAIL:E2EE:1:([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new Error("Unsupported PhoneMail QR format");
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(match[1])));
  } catch {
    throw new Error("Malformed PhoneMail QR data");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Malformed PhoneMail QR data");
  const item = payload as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["version", "userId", "fingerprint", "address"].includes(key)) ||
      item.version !== 1 || typeof item.userId !== "string" || !UUID.test(item.userId) ||
      typeof item.fingerprint !== "string" || !/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(item.fingerprint) ||
      item.address !== undefined && (typeof item.address !== "string" || !/^[0-9]{8,15}@phonemail\.com$/i.test(item.address))) {
    throw new Error("Invalid PhoneMail QR identity fields");
  }
  return item as unknown as QrIdentity;
}

export async function exportIdentity(identity: LocalIdentity) {
  const imported = await openpgp.readPrivateKey({ armoredKey: identity.encryptedPrivateKey });
  if (imported.isDecrypted()) throw new Error("Refusing to export an unprotected private key");
  const publicKey = imported.toPublic();
  if (publicKey.getFingerprint().toUpperCase() !== identity.fingerprint.toUpperCase()) {
    throw new Error("Private-key fingerprint does not match the identity");
  }
  return identity.encryptedPrivateKey;
}

export interface ProtectedPrivateKeyStore {
  save(userId: string, armoredEncryptedPrivateKey: string): Promise<void>;
  load(userId: string): Promise<string | undefined>;
  remove(userId: string): Promise<void>;
}

export function createBrowserProtectedKeyStore(storage?: Storage): ProtectedPrivateKeyStore {
  if (typeof window === "undefined" || !window.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error("Private-key storage requires a secure browser context with Web Crypto");
  }
  const target = storage ?? window.localStorage;
  const key = (userId: string) => {
    assertUuid(userId);
    return `phonemail.e2ee.encrypted-private-key.v1:${userId.toLowerCase()}`;
  };
  return {
    async save(userId, armoredEncryptedPrivateKey) {
      await assertEncryptedPrivateKey(armoredEncryptedPrivateKey);
      target.setItem(key(userId), armoredEncryptedPrivateKey);
    },
    async load(userId) {
      const value = target.getItem(key(userId));
      if (value === null) return undefined;
      await assertEncryptedPrivateKey(value);
      return value;
    },
    async remove(userId) {
      target.removeItem(key(userId));
    },
  };
}

export type NativeSecureStorageAdapter = {
  readonly platform: "ios" | "android";
  readonly storage: "apple-keychain" | "android-keystore";
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};

export function createNativeProtectedKeyStore(adapter: NativeSecureStorageAdapter): ProtectedPrivateKeyStore {
  const key = (userId: string) => {
    assertUuid(userId);
    return `phonemail.e2ee.encrypted-private-key.v1:${userId.toLowerCase()}`;
  };
  if ((adapter.platform === "ios" && adapter.storage !== "apple-keychain") ||
      (adapter.platform === "android" && adapter.storage !== "android-keystore")) {
    throw new Error("Native private keys must use the platform keychain or keystore-backed secure storage");
  }
  return {
    async save(userId, armoredEncryptedPrivateKey) {
      await assertEncryptedPrivateKey(armoredEncryptedPrivateKey);
      await adapter.setItem(key(userId), armoredEncryptedPrivateKey);
    },
    async load(userId) {
      const value = await adapter.getItem(key(userId));
      if (value === null) return undefined;
      await assertEncryptedPrivateKey(value);
      return value;
    },
    async remove(userId) {
      await adapter.deleteItem(key(userId));
    },
  };
}

async function assertEncryptedPrivateKey(value: string) {
  if (value.length > 32 * 1024 || !value.startsWith("-----BEGIN PGP PRIVATE KEY BLOCK-----")) {
    throw new Error("Only bounded passphrase-protected armored private keys can be stored");
  }
  const key = await openpgp.readPrivateKey({ armoredKey: value });
  if (key.isDecrypted()) throw new Error("Unprotected private keys cannot be stored");
}

export function compareQrIdentity(payload: QrIdentity, knownFingerprint?: string) {
  if (!knownFingerprint) return { status: "first-use-unverified" as const, matches: false };
  const matches = payload.fingerprint.toUpperCase() === knownFingerprint.toUpperCase();
  return { status: matches ? "fingerprint-matches" as const : "fingerprint-mismatch" as const, matches };
}

function toBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
