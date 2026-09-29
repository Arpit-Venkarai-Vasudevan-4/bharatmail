import {t} from '../../i18n';
import { restoreSignedPrepared, signPrepared, type DurablePrepared } from "./durable";
import {
  compareQrIdentity,
  createIdentity,
  decryptMime,
  encryptInnerMime,
  encryptMime,
  importIdentity,
  readQrPayload,
  signChallenge,
  validatePublicIdentity,
  type LocalIdentity,
  type QrIdentity,
} from "./index";

export type E2eeProgress = {
  state:
    | "preparing"
    | "reauthenticating"
    | "generating-key"
    | "signing"
    | "resolving-keys"
    | "encrypting"
    | "saving"
    | "sending"
    | "decrypting"
    | "complete"
    | "error";
};

export type E2eeErrorCode =
  | "NETWORK_ERROR"
  | "AUTHENTICATION_FAILED"
  | "REAUTHENTICATION_REQUIRED"
  | "RECIPIENT_KEY_MISSING"
  | "KEY_REVOKED"
  | "KEY_CHANGED"
  | "TRUST_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "REVISION_CONFLICT"
  | "CRYPTOGRAPHY_FAILED"
  | "INVALID_RESPONSE"
  | "REQUEST_REJECTED";

export class E2eeClientError extends Error {
  constructor(
    readonly code: E2eeErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message.slice(0, 240));
    this.name = "E2eeClientError";
  }
}

export type CurrentPublicKey = {
  userId: string;
  fingerprint: string;
  encryptionKeyId: string;
  publicKey: string;
  createdAt: string;
};

export type StoredTrust = {
  userId: string;
  fingerprint: string;
};

export interface FingerprintTrustStore {
  get(userId: string): Promise<StoredTrust | undefined>;
  getHistory?(userId: string): Promise<StoredTrust[]>;
  set(trust: StoredTrust): Promise<void>;
  remove(userId: string): Promise<void>;
}

export type TrustedQrStatus = {
  identity: QrIdentity;
  currentKey: CurrentPublicKey;
  trust:
    | "first-use-unverified"
    | "fingerprint-matches"
    | "fingerprint-mismatch";
  requiresUserDecision: true;
};

export type E2eeClientOptions = {
  apiBaseUrl: string;
  accessToken?: () => string | undefined;
  /** Browser transport delegates cookies, CSRF, and renewal to the application. Never combines bearer and cookies. */
  request?: <T>(path: string, input: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<T>;
  trustStore: FingerprintTrustStore;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  onProgress?: (progress: E2eeProgress) => void;
};

export type EncryptedMessageInput = {
  sender: LocalIdentity;
  passphrase: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  attachments?: File[];
  idempotencyKey: string;
  replyToId?: string;
};

export type PreparedEncryptedMessage = {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly ciphertext: string;
  readonly keyFingerprints: readonly string[];
  readonly idempotencyKey: string;
  readonly replyToId?: string;
};

export type PreparedEncryptedDraftSend = PreparedEncryptedMessage & {
  readonly draftId: string;
  readonly revision: number;
};

export class PhoneMailE2eeClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly preparedMessages = new WeakSet<object>();
  private readonly preparedDrafts = new WeakSet<object>();
  private readonly preparedOwners = new WeakMap<object, string>();

  constructor(private readonly options: E2eeClientOptions) {
    this.baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    if (!/^https?:\/\/[^/]+$/i.test(this.baseUrl)) {
      throw new E2eeClientError("REQUEST_REJECTED", t("m_72cd95faa00e"));
    }
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30_000) {
      throw new E2eeClientError("REQUEST_REJECTED", t("m_7fa4e10e2332"));
    }
  }

  async createIdentity(userId: string, passphrase: string) {
    return this.run("generating-key", () => createIdentity(userId, passphrase));
  }

  async importIdentity(userId: string, encryptedPrivateKey: string, passphrase: string) {
    return this.run("preparing", () => importIdentity(userId, encryptedPrivateKey, passphrase));
  }

  async reauthenticate(password: string) {
    return this.run("reauthenticating", () =>
      this.reauthenticateRequest(password),
    );
  }

  async enroll(identity: LocalIdentity, passphrase: string, password: string) {
    return this.run("signing", async () => {
      this.options.onProgress?.({ state: "reauthenticating" });
      await this.reauthenticateRequest(password);
      const challenge = await this.issueChallenge("enroll");
      const proof = await signChallenge(identity, passphrase, challenge.challenge.challenge);
      return this.request<{ key: { fingerprint: string } }>("/api/e2ee/keys", {
        method: "POST",
        body: {
          action: "enroll",
          challengeId: challenge.challenge.id,
          publicKey: identity.publicKey,
          proof,
        },
      });
    });
  }

  async rotate(identity: LocalIdentity, nextIdentity: LocalIdentity, passphrase: string, password: string) {
    return this.run("signing", async () => {
      this.options.onProgress?.({ state: "reauthenticating" });
      await this.reauthenticateRequest(password);
      const challenge = await this.issueChallenge("rotate");
      const [proof, previousProof] = await Promise.all([
        signChallenge(nextIdentity, passphrase, challenge.challenge.challenge),
        signChallenge(identity, passphrase, challenge.challenge.challenge),
      ]);
      return this.request<{ key: { fingerprint: string } }>("/api/e2ee/keys", {
        method: "POST",
        body: {
          action: "rotate",
          challengeId: challenge.challenge.id,
          publicKey: nextIdentity.publicKey,
          proof,
          previousProof,
        },
      });
    });
  }

  async revoke(identity: LocalIdentity, passphrase: string, password: string) {
    return this.run("signing", async () => {
      this.options.onProgress?.({ state: "reauthenticating" });
      await this.reauthenticateRequest(password);
      const challenge = await this.issueChallenge("revoke");
      const proof = await signChallenge(identity, passphrase, challenge.challenge.challenge);
      return this.request<{ key: { action: "revoke" } }>("/api/e2ee/keys/current", {
        method: "DELETE",
        body: { challengeId: challenge.challenge.id, proof },
      });
    });
  }

  async inspectQr(payload: string): Promise<TrustedQrStatus> {
    return this.run("resolving-keys", async () => {
      const identity = await readQrPayload(payload);
      let currentKey: CurrentPublicKey;
      try {
        currentKey = await this.currentKey(identity.userId);
      } catch (error) {
        if (error instanceof E2eeClientError && error.code === "RECIPIENT_KEY_MISSING") {
          throw new E2eeClientError("KEY_REVOKED", t("m_97ffb835b16c"));
        }
        throw error;
      }
      if (currentKey.fingerprint.toUpperCase() !== identity.fingerprint) {
        throw new E2eeClientError("KEY_CHANGED", t("m_276701fed016"));
      }
      const existing = await this.options.trustStore.get(identity.userId);
      const comparison = compareQrIdentity(identity, existing?.fingerprint);
      return { identity, currentKey, trust: comparison.status, requiresUserDecision: true };
    });
  }

  async trustQr(status: TrustedQrStatus, confirmedOutOfBand: boolean) {
    if (!confirmedOutOfBand) {
      throw new E2eeClientError("TRUST_REQUIRED", t("m_df821a1cedfb"));
    }
    const current = await this.currentKey(status.identity.userId);
    if (current.fingerprint.toUpperCase() !== status.identity.fingerprint ||
        current.fingerprint.toUpperCase() !== status.currentKey.fingerprint.toUpperCase()) {
      throw new E2eeClientError("KEY_CHANGED", t("m_2b9444bbf986"));
    }
    await this.options.trustStore.set({
      userId: status.identity.userId,
      fingerprint: current.fingerprint.toUpperCase(),
    });
  }

  async removeTrust(userId: string) {
    await this.options.trustStore.remove(userId);
  }

  async prepareEncryptedMessage(input: EncryptedMessageInput): Promise<PreparedEncryptedMessage> {
    return this.run("resolving-keys", async () => {
      const { to, cc } = validateRecipients(input.to, input.cc ?? [], input.sender.userId);
      assertIdempotencyKey(input.idempotencyKey);
      if (input.replyToId) uniqueIds([input.replyToId]);
      this.options.onProgress?.({ state: "resolving-keys" });
      const senderKey = await this.currentKey(input.sender.userId);
      assertSameKey(senderKey, input.sender);
      const recipientIds = [...new Set([...to, ...cc])];
      const keys = await Promise.all(recipientIds.map((id) => this.currentKey(id)));
      await this.requireTrusted(keys);
      const recipients = [senderKey, ...keys].map((key) => ({
        userId: key.userId,
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        encryptedPrivateKey: key.userId === input.sender.userId ? input.sender.encryptedPrivateKey : "",
      }));
      this.options.onProgress?.({ state: "encrypting" });
      const encrypted = await encryptMime(recipients, input.passphrase, {
        subject: input.subject,
        text: input.text,
        attachments: input.attachments,
      });
      const prepared = Object.freeze({
        to: Object.freeze(to.slice()),
        cc: Object.freeze(cc.slice()),
        ciphertext: encrypted.ciphertext,
        keyFingerprints: Object.freeze(encrypted.keyFingerprints.slice()),
        idempotencyKey: input.idempotencyKey,
        ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      });
      this.preparedMessages.add(prepared);
      this.preparedOwners.set(prepared, `${input.sender.userId}:${input.sender.fingerprint}`);
      return prepared;
    });
  }

  async sendPreparedMessage(prepared: PreparedEncryptedMessage) {
    if (!this.preparedMessages.has(prepared)) {
      throw new E2eeClientError("REQUEST_REJECTED", t("m_f80ba71c85f8"));
    }
    assertIdempotencyKey(prepared.idempotencyKey);
    return this.run("sending", () => this.request<{ message: { messageId: string; conversationId: string; duplicate: boolean } }>(
      "/api/e2ee/messages",
      {
        method: "POST",
        idempotencyKey: prepared.idempotencyKey,
        body: {
          to: prepared.to,
          cc: prepared.cc,
          ciphertext: prepared.ciphertext,
          keyFingerprints: prepared.keyFingerprints,
          ...(prepared.replyToId ? { replyToId: prepared.replyToId } : {}),
        },
      },
    ));
  }

  async sendEncrypted(input: EncryptedMessageInput) {
    const prepared = await this.prepareEncryptedMessage(input);
    return this.sendPreparedMessage(prepared);
  }

  async saveEncryptedDraft(
    identity: LocalIdentity,
    passphrase: string,
    content: { subject: string; text: string; attachments?: File[]; draftRouting?: { to: string[]; cc: string[] } },
  ) {
    return this.run("encrypting", async () => {
      const current = await this.currentKey(identity.userId);
      assertSameKey(current, identity);
      const encrypted = await encryptMime([identity], passphrase, content);
      this.options.onProgress?.({ state: "saving" });
      return this.request<{ draft: { id: string; revision: number } }>("/api/e2ee/drafts", {
        method: "POST",
        body: { ciphertext: encrypted.ciphertext },
      });
    });
  }

  async updateEncryptedDraft(
    identity: LocalIdentity,
    passphrase: string,
    draftId: string,
    revision: number,
    content: { subject: string; text: string; attachments?: File[]; draftRouting?: { to: string[]; cc: string[] } },
  ) {
    return this.run("encrypting", async () => {
      const current = await this.currentKey(identity.userId);
      assertSameKey(current, identity);
      const encrypted = await encryptMime([identity], passphrase, content);
      this.options.onProgress?.({ state: "saving" });
      return this.request<{ draft: { id: string; revision: number } }>(`/api/e2ee/drafts/${encodeURIComponent(draftId)}`, {
        method: "PUT",
        body: { ciphertext: encrypted.ciphertext, revision },
      });
    });
  }

  async prepareEncryptedDraftSend(input: EncryptedMessageInput & { draftId: string; revision: number }): Promise<PreparedEncryptedDraftSend> {
    return this.run("resolving-keys", async () => {
      if (input.replyToId) throw new E2eeClientError("REQUEST_REJECTED", t("m_1e87e020a1c1"));
      const draft = await this.request<{ draft: { ciphertext: string; revision: number } }>(
        `/api/e2ee/drafts/${encodeURIComponent(input.draftId)}`,
      );
      if (draft.draft.revision !== input.revision) {
        throw new E2eeClientError("REVISION_CONFLICT", t("m_f96a39a107f5"));
      }
      const plaintextMime = await decryptMime(
        input.sender,
        input.passphrase,
        draft.draft.ciphertext,
      );
      return this.prepareMimeDraftSend(input, plaintextMime);
    });
  }

  async sendPreparedDraft(prepared: PreparedEncryptedDraftSend) {
    if (!this.preparedDrafts.has(prepared)) {
      throw new E2eeClientError("REQUEST_REJECTED", t("m_86b0fcbe66d7"));
    }
    assertIdempotencyKey(prepared.idempotencyKey);
    return this.run("sending", () => this.request<{ message: { messageId: string; duplicate: boolean } }>(
      `/api/e2ee/drafts/${encodeURIComponent(prepared.draftId)}/send`,
      {
        method: "POST",
        idempotencyKey: prepared.idempotencyKey,
        body: {
          revision: prepared.revision,
          to: prepared.to,
          cc: prepared.cc,
          ciphertext: prepared.ciphertext,
          keyFingerprints: prepared.keyFingerprints,
        },
      },
    ));
  }

  async decryptMessage(identity: LocalIdentity, passphrase: string, messageId: string) {
    return this.run("decrypting", async () => {
      const response = await this.request<{ message: { senderUserId: string; ciphertext: string } }>(
        `/api/e2ee/messages/${encodeURIComponent(messageId)}`,
      );
      const senderId = response.message.senderUserId;
      let signers: LocalIdentity[];
      if (senderId === identity.userId) {
        signers = [identity];
      } else {
        const trust = await this.options.trustStore.get(senderId);
        if (!trust) throw new E2eeClientError("TRUST_REQUIRED", t("m_8ae5c383f4c7"));
        const history = await this.request<{ keys: CurrentPublicKey[] }>(
          `/api/e2ee/keys/${encodeURIComponent(senderId)}/history`,
        );
        const trustedHistory = this.options.trustStore.getHistory ? await this.options.trustStore.getHistory(senderId) : [trust];
        const approved = new Set([trust, ...trustedHistory].map(item => item.fingerprint.toUpperCase()));
        const matchingKeys = history.keys.filter((key) => approved.has(key.fingerprint.toUpperCase()));
        if (!matchingKeys.length) throw new E2eeClientError("KEY_CHANGED", t("m_b1c961522347"));
        await Promise.all(matchingKeys.map(validatePublicIdentity));
        signers = matchingKeys.map((key) => ({
          userId: key.userId,
          fingerprint: key.fingerprint,
          publicKey: key.publicKey,
          encryptedPrivateKey: "",
        }));
      }
      return decryptMime(
        identity,
        passphrase,
        response.message.ciphertext,
        signers,
      );
    });
  }

  /** Only this instance's validated prepared objects may be signed for durable replay. */
  async exportPrepared(prepared: PreparedEncryptedMessage | PreparedEncryptedDraftSend, identity: LocalIdentity, passphrase: string): Promise<DurablePrepared> {
    const kind = this.preparedDrafts.has(prepared) ? "draft" : this.preparedMessages.has(prepared) ? "message" : undefined;
    if (!kind || this.preparedOwners.get(prepared) !== `${identity.userId}:${identity.fingerprint}`) throw new E2eeClientError("REQUEST_REJECTED", t("m_3a788cc27f9d"));
    return signPrepared(kind, prepared, identity, passphrase);
  }

  /** Verifies account binding, signature, schema and retry window before restoring instance authority. */
  async restorePrepared(record: unknown, identity: LocalIdentity): Promise<PreparedEncryptedMessage | PreparedEncryptedDraftSend> {
    const restored = await restoreSignedPrepared(record, identity);
    if (restored.kind === "draft") this.preparedDrafts.add(restored.prepared);
    else this.preparedMessages.add(restored.prepared);
    return restored.prepared;
  }

  private async prepareMimeDraftSend(input: EncryptedMessageInput & { draftId: string; revision: number }, mime: string): Promise<PreparedEncryptedDraftSend> {
    const { to, cc } = validateRecipients(input.to, input.cc ?? [], input.sender.userId);
    assertIdempotencyKey(input.idempotencyKey);
    const senderKey = await this.currentKey(input.sender.userId);
    assertSameKey(senderKey, input.sender);
    const recipientKeys = await Promise.all([...new Set([...to, ...cc])].map((id) => this.currentKey(id)));
    await this.requireTrusted(recipientKeys);
    const encrypted = await encryptInnerMime(
      [senderKey, ...recipientKeys].map((key) => ({
        userId: key.userId,
        fingerprint: key.fingerprint,
        publicKey: key.publicKey,
        encryptedPrivateKey: key.userId === input.sender.userId ? input.sender.encryptedPrivateKey : "",
      })),
      input.passphrase,
      mime,
    );
    const prepared = Object.freeze({
      draftId: input.draftId,
      revision: input.revision,
      to: Object.freeze(to.slice()),
      cc: Object.freeze(cc.slice()),
      ciphertext: encrypted.ciphertext,
      keyFingerprints: Object.freeze(encrypted.keyFingerprints.slice()),
      idempotencyKey: input.idempotencyKey,
    });
    this.preparedDrafts.add(prepared);
    this.preparedOwners.set(prepared, `${input.sender.userId}:${input.sender.fingerprint}`);
    return prepared;
  }

  private async requireTrusted(keys: CurrentPublicKey[]) {
    for (const key of keys) {
      const trusted = await this.options.trustStore.get(key.userId);
      if (!trusted) throw new E2eeClientError("TRUST_REQUIRED", t('security.verifyRecipient'));
      if (trusted.fingerprint.toUpperCase() !== key.fingerprint.toUpperCase()) {
        throw new E2eeClientError("KEY_CHANGED", t('security.changedRecipient'));
      }
    }
  }

  private async currentKey(userId: string): Promise<CurrentPublicKey> {
    try {
      const result = await this.request<{ key: CurrentPublicKey }>(`/api/e2ee/keys/${encodeURIComponent(userId)}`);
      await validatePublicIdentity(result.key);
      return result.key;
    } catch (error) {
      if (error instanceof E2eeClientError && error.status === 404) {
        throw new E2eeClientError("RECIPIENT_KEY_MISSING", t('security.missingRecipientKey'), 404);
      }
      throw error;
    }
  }

  private async issueChallenge(action: "enroll" | "rotate" | "revoke") {
    return this.request<{ challenge: { id: string; challenge: string } }>("/api/e2ee/key-challenges", {
      method: "POST",
      body: { action },
    });
  }

  private reauthenticateRequest(password: string) {
    return this.request<void>("/api/e2ee/reauth", {
      method: "POST",
      body: { password },
    });
  }

  private async request<T>(
    path: string,
    input: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    if (this.options.request) return this.options.request<T>(path, input);
    const token = this.options.accessToken?.();
    if (!token) throw new E2eeClientError("AUTHENTICATION_FAILED", t("m_72321713ee6b"));
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: input.method ?? "GET",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
          ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
    } catch {
      throw new E2eeClientError("NETWORK_ERROR", t("m_65a871b6cabd"));
    }
    if (response.status === 204) {
      if (!response.ok) throw new E2eeClientError("REQUEST_REJECTED", t("m_8f5400e5a6df"), response.status);
      return undefined as T;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new E2eeClientError("INVALID_RESPONSE", t("m_a149e865e849"), response.status);
    }
    if (!response.ok) {
      const message = errorMessage(payload);
      const code = errorCode(payload);
      const mapped = code === "REAUTH_REQUIRED"
        ? "REAUTHENTICATION_REQUIRED"
        : code === "IDEMPOTENCY_CONFLICT"
          ? "IDEMPOTENCY_CONFLICT"
          : code === "REVISION_CONFLICT"
            ? "REVISION_CONFLICT"
            : response.status === 401
              ? "AUTHENTICATION_FAILED"
              : "REQUEST_REJECTED";
      throw new E2eeClientError(mapped, message, response.status);
    }
    return payload as T;
  }

  private async run<T>(state: E2eeProgress["state"], action: () => Promise<T>): Promise<T> {
    this.options.onProgress?.({ state });
    try {
      const result = await action();
      this.options.onProgress?.({ state: "complete" });
      return result;
    } catch (error) {
      this.options.onProgress?.({ state: "error" });
      if (error instanceof E2eeClientError) throw error;
      const message = error instanceof Error ? error.message : "Cryptographic operation failed";
      throw new E2eeClientError("CRYPTOGRAPHY_FAILED", boundedMessage(message));
    }
  }
}

function uniqueIds(values: string[]) {
  if (values.length > 50 || values.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))) {
    throw new E2eeClientError("REQUEST_REJECTED", t("m_35e380d17aa9"));
  }
  if (new Set(values).size !== values.length) {
    throw new E2eeClientError("REQUEST_REJECTED", t("m_f7a7823707de"));
  }
  return values;
}

function validateRecipients(toInput: string[], ccInput: string[], senderId: string) {
  const to = uniqueIds(toInput);
  const cc = uniqueIds(ccInput);
  if (!to.length || to.length + cc.length > 49 || to.some((id) => cc.includes(id)) ||
      [...to, ...cc].some((id) => id === senderId)) {
    throw new E2eeClientError("REQUEST_REJECTED", t("m_bd5d8591493b"));
  }
  return { to, cc };
}

function assertIdempotencyKey(value: string) {
  if (!/^[\x20-\x7e]{8,128}$/.test(value)) {
    throw new E2eeClientError("REQUEST_REJECTED", t("m_5d4790a47fdc"));
  }
}

function assertSameKey(current: CurrentPublicKey, identity: LocalIdentity) {
  if (current.userId !== identity.userId || current.fingerprint.toUpperCase() !== identity.fingerprint.toUpperCase()) {
    throw new E2eeClientError("KEY_CHANGED", t("m_e611d79b31d6"));
  }
}

function errorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return "PhoneMail API rejected the request";
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return "PhoneMail API rejected the request";
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? boundedMessage(message) : "PhoneMail API rejected the request";
}

function errorCode(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return "";
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : "";
}

function boundedMessage(message: string) {
  return message.replace(/[\r\n\0]/g, " ").slice(0, 240) || "Operation failed";
}
