import QRCode from "qrcode";
import { Html5Qrcode } from "html5-qrcode";
import {
  compareQrIdentity,
  createIdentity,
  decryptMime,
  encryptMime,
  exportIdentity,
  importIdentity,
  makeQrPayload,
  readQrPayload,
  signChallenge,
  createBrowserProtectedKeyStore,
  type LocalIdentity,
} from "@phonemail/e2ee-client";
import "./style.css";

const $ = <T extends HTMLElement>(selector: string) => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing demo element: ${selector}`);
  return element;
};
const input = (selector: string) => $<HTMLInputElement>(selector);
const textarea = (selector: string) => $<HTMLTextAreaElement>(selector);

let identityA: LocalIdentity | undefined;
let identityB: LocalIdentity | undefined;
let encryptedMime = "";
let authA: { token: string; userId: string } | undefined;
let authB: { token: string; userId: string } | undefined;
let savedDraft: { id: string; revision: number } | undefined;
let scanner: Html5Qrcode | undefined;
let scannedIdentity: Awaited<ReturnType<typeof readQrPayload>> | undefined;
let protectedKeyStore: ReturnType<typeof createBrowserProtectedKeyStore> | undefined;

function getProtectedKeyStore() {
  protectedKeyStore ??= createBrowserProtectedKeyStore();
  return protectedKeyStore;
}

function showError(error: unknown) {
  const result = $("#result");
  result.textContent = error instanceof Error ? error.message : "Operation failed";
}

$("#generate-a").addEventListener("click", async () => {
  try {
    identityA = await createIdentity(input("#user-a").value, input("#pass-a").value);
    await getProtectedKeyStore().save(identityA.userId, identityA.encryptedPrivateKey);
    input("#export-a").disabled = false;
    $("#send").removeAttribute("disabled");
    $("#result").textContent = `A public fingerprint: ${identityA.fingerprint}\nPrivate key remains only in this page's memory and is passphrase-encrypted.`;
    input("#show-qr-a").disabled = false;
    input("#register-a").disabled = !authA;
    input("#save-draft").disabled = !authA;
    input("#api-send").disabled = !(authA && authB && identityB);
  } catch (error) { showError(error); }
});

$("#generate-b").addEventListener("click", async () => {
  try {
    identityB = await createIdentity(input("#user-b").value, input("#pass-b").value);
    await getProtectedKeyStore().save(identityB.userId, identityB.encryptedPrivateKey);
    input("#export-b").disabled = false;
    $("#result").textContent = `B public fingerprint: ${identityB.fingerprint}\nPrivate key remains only in this page's memory and is passphrase-encrypted.`;
    input("#show-qr").disabled = false;
    input("#register-b").disabled = !authB;
    input("#api-receive").disabled = !authB;
    input("#api-send").disabled = !(authA && identityA);
  } catch (error) { showError(error); }
});

async function apiRequest(path: string, init: RequestInit = {}, token?: string) {
  const base = input("#api-base").value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+$/i.test(base)) throw new Error("Enter an absolute HTTP(S) API origin");
  const response = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `API request failed (${response.status})`);
  return body;
}

async function login(which: "a" | "b") {
  const result = await apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ phone: input(`#phone-${which}`).value, password: input(`#api-pass-${which}`).value }),
  });
  const auth = { token: result.token as string, userId: result.user.id as string };
  if (which === "a") {
    authA = auth;
    input("#user-a").value = auth.userId;
    input("#register-a").disabled = false;
    input("#api-send").disabled = !(identityA && authB && identityB);
    input("#save-draft").disabled = !identityA;
  } else {
    authB = auth;
    input("#user-b").value = auth.userId;
    input("#recipient-id").value = auth.userId;
    input("#register-b").disabled = false;
  }
  $("#api-status").textContent = `Identity ${which.toUpperCase()} authenticated as ${auth.userId}. Access token remains in page memory.`;
}

async function enroll(which: "a" | "b") {
  const auth = which === "a" ? authA : authB;
  const identity = which === "a" ? identityA : identityB;
  const passphrase = input(`#pass-${which}`).value;
  if (!auth || !identity || identity.userId !== auth.userId) {
    throw new Error(`Authenticate ${which.toUpperCase()} and create/import a matching local key first`);
  }
  await apiRequest("/api/e2ee/reauth", {
    method: "POST",
    body: JSON.stringify({ password: input(`#api-pass-${which}`).value }),
  }, auth.token);
  const challenge = await apiRequest("/api/e2ee/key-challenges", {
    method: "POST",
    body: JSON.stringify({ action: "enroll" }),
  }, auth.token);
  const proof = await signChallenge(identity, passphrase, challenge.challenge.challenge);
  const result = await apiRequest("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({
      action: "enroll",
      challengeId: challenge.challenge.id,
      publicKey: identity.publicKey,
      proof,
    }),
  }, auth.token);
  $("#api-status").textContent = `Identity ${which.toUpperCase()} published public fingerprint ${result.key.fingerprint}. Private key was not uploaded.`;
}

async function rotate(which: "a" | "b") {
  if (!input("#rotation-backup").checked) throw new Error("Export and verify the existing encrypted private-key backup before rotation");
  const auth = which === "a" ? authA : authB;
  const oldIdentity = which === "a" ? identityA : identityB;
  const passphrase = input(`#pass-${which}`).value;
  if (!auth || !oldIdentity || oldIdentity.userId !== auth.userId) throw new Error("Authenticate and load the current local key first");
  await apiRequest("/api/e2ee/reauth", {
    method: "POST", body: JSON.stringify({ password: input(`#api-pass-${which}`).value }),
  }, auth.token);
  const nextIdentity = await createIdentity(auth.userId, passphrase);
  const challenge = await apiRequest("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "rotate" }),
  }, auth.token);
  const proof = await signChallenge(nextIdentity, passphrase, challenge.challenge.challenge);
  const previousProof = await signChallenge(oldIdentity, passphrase, challenge.challenge.challenge);
  await apiRequest("/api/e2ee/keys", {
    method: "POST",
    body: JSON.stringify({
      action: "rotate",
      challengeId: challenge.challenge.id,
      publicKey: nextIdentity.publicKey,
      proof,
      previousProof,
    }),
  }, auth.token);
  if (which === "a") identityA = nextIdentity;
  else identityB = nextIdentity;
  await getProtectedKeyStore().save(nextIdentity.userId, nextIdentity.encryptedPrivateKey);
  input(`#export-${which}`).disabled = false;
  $("#api-status").textContent = `Identity ${which.toUpperCase()} key rotated to ${nextIdentity.fingerprint}; preserve the old key backup for historical messages.`;
}

async function revoke(which: "a" | "b") {
  const auth = which === "a" ? authA : authB;
  const identity = which === "a" ? identityA : identityB;
  if (!auth || !identity || identity.userId !== auth.userId) throw new Error("Authenticate and load the current local key first");
  await apiRequest("/api/e2ee/reauth", {
    method: "POST", body: JSON.stringify({ password: input(`#api-pass-${which}`).value }),
  }, auth.token);
  const challenge = await apiRequest("/api/e2ee/key-challenges", {
    method: "POST", body: JSON.stringify({ action: "revoke" }),
  }, auth.token);
  await apiRequest("/api/e2ee/keys/current", {
    method: "DELETE",
    body: JSON.stringify({
      challengeId: challenge.challenge.id,
      proof: await signChallenge(identity, input(`#pass-${which}`).value, challenge.challenge.challenge),
    }),
  }, auth.token);
  $("#api-status").textContent = `Identity ${which.toUpperCase()} public key revoked. Existing encrypted messages remain ciphertext-only.`;
}

async function downloadPrivateKey(which: "a" | "b") {
  const identity = which === "a" ? identityA : identityB;
  if (!identity) throw new Error(`Generate or import identity ${which.toUpperCase()} first`);
  const encryptedPrivateKey = await exportIdentity(identity);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([encryptedPrivateKey], { type: "application/pgp-keys" }));
  link.download = `phonemail-${identity.userId}-encrypted-private-key.asc`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function importKey(which: "a" | "b") {
  const file = input("#import-key").files?.[0];
  if (!file || file.size > 32 * 1024) throw new Error("Choose a private key file under 32 KiB");
  const identity = await importIdentity(input(`#user-${which}`).value, await file.text(), input(`#pass-${which}`).value);
  if (which === "a") identityA = identity;
  else identityB = identity;
  await getProtectedKeyStore().save(identity.userId, identity.encryptedPrivateKey);
  input(`#export-${which}`).disabled = false;
  input(`#register-${which}`).disabled = !(which === "a" ? authA : authB);
  input(which === "a" ? "#show-qr-a" : "#show-qr").disabled = false;
  if (which === "a" && authA && authB) input("#api-send").disabled = false;
  if (which === "b" && authB) input("#api-receive").disabled = false;
  $("#api-status").textContent = `Imported encrypted private key ${identity.fingerprint}; it remains only in page memory.`;
}

async function loadStoredKey(which: "a" | "b") {
  const userId = input(`#user-${which}`).value.trim();
  const encryptedKey = await getProtectedKeyStore().load(userId);
  if (!encryptedKey) throw new Error(`No protected browser key is saved for identity ${which.toUpperCase()}`);
  const identity = await importIdentity(userId, encryptedKey, input(`#pass-${which}`).value);
  if (which === "a") identityA = identity;
  else identityB = identity;
  input(`#export-${which}`).disabled = false;
  input(which === "a" ? "#show-qr-a" : "#show-qr").disabled = false;
  input(`#register-${which}`).disabled = !(which === "a" ? authA : authB);
  $("#api-status").textContent = `Loaded passphrase-protected key ${identity.fingerprint} from this browser's local storage.`;
}

input("#login-a").addEventListener("click", async () => {
  try { await login("a"); } catch (error) { showError(error); }
});
input("#login-b").addEventListener("click", async () => {
  try { await login("b"); } catch (error) { showError(error); }
});
input("#register-a").addEventListener("click", async () => {
  try { await enroll("a"); } catch (error) { showError(error); }
});
input("#register-b").addEventListener("click", async () => {
  try { await enroll("b"); } catch (error) { showError(error); }
});
input("#rotate-a").addEventListener("click", async () => { try { await rotate("a"); } catch (error) { showError(error); } });
input("#rotate-b").addEventListener("click", async () => { try { await rotate("b"); } catch (error) { showError(error); } });
input("#revoke-a").addEventListener("click", async () => { try { await revoke("a"); } catch (error) { showError(error); } });
input("#revoke-b").addEventListener("click", async () => { try { await revoke("b"); } catch (error) { showError(error); } });
input("#export-a").addEventListener("click", async () => { try { await downloadPrivateKey("a"); } catch (error) { showError(error); } });
input("#export-b").addEventListener("click", async () => { try { await downloadPrivateKey("b"); } catch (error) { showError(error); } });
input("#import-a").addEventListener("click", async () => { try { await importKey("a"); } catch (error) { showError(error); } });
input("#import-b").addEventListener("click", async () => { try { await importKey("b"); } catch (error) { showError(error); } });
input("#load-a").addEventListener("click", async () => { try { await loadStoredKey("a"); } catch (error) { showError(error); } });
input("#load-b").addEventListener("click", async () => { try { await loadStoredKey("b"); } catch (error) { showError(error); } });

async function showQr(which: "a" | "b") {
  try {
    const identity = which === "a" ? identityA : identityB;
    if (!identity) throw new Error(`Generate identity ${which.toUpperCase()} first`);
    if (!input("#qr-confirm").checked) throw new Error("Confirm the key-sharing and address-exposure notice first");
    const address = input("#qr-address").value.trim();
    if (address) {
      const auth = which === "a" ? authA : authB;
      if (!auth || auth.userId !== identity.userId) {
        throw new Error("Authenticate this PhoneMail account before sharing its address");
      }
      const profile = await apiRequest("/api/me/addresses", {}, auth.token);
      if (!profile.addresses.some((item: { email: string; isPrimary: boolean; isActive: boolean }) =>
        item.isPrimary && item.isActive && item.email.toLowerCase() === address.toLowerCase())) {
        throw new Error("The shared address must be this account's active primary PhoneMail address");
      }
    }
    const payload = await makeQrPayload(identity, address || undefined);
    const image = document.createElement("img");
    image.alt = `PhoneMail public identity ${which.toUpperCase()} QR code`;
    image.src = await QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 2 });
    $("#qr").replaceChildren(image);
    textarea("#qr-input").value = payload;
  } catch (error) { showError(error); }
}

input("#show-qr-a").addEventListener("click", () => { void showQr("a"); });
input("#show-qr").addEventListener("click", () => { void showQr("b"); });

input("#start-scanner").addEventListener("click", async () => {
  try {
    if (scanner) return;
    scanner = new Html5Qrcode("qr-reader");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: { width: 240, height: 240 } },
      (decoded) => {
        textarea("#qr-input").value = decoded;
        void scanner?.stop().then(() => {
          scanner = undefined;
          input("#start-scanner").disabled = false;
          input("#stop-scanner").disabled = true;
          input("#verify-qr").click();
        }).catch(showError);
      },
      () => undefined,
    );
    input("#start-scanner").disabled = true;
    input("#stop-scanner").disabled = false;
  } catch (error) {
    scanner = undefined;
    $("#trust").textContent = error instanceof Error ? error.message : "Camera access failed";
  }
});

input("#stop-scanner").addEventListener("click", async () => {
  try {
    if (!scanner) return;
    await scanner.stop();
    scanner.clear();
    scanner = undefined;
    input("#start-scanner").disabled = false;
    input("#stop-scanner").disabled = true;
  } catch (error) { showError(error); }
});
window.addEventListener("pagehide", () => {
  if (scanner) void scanner.stop().catch(() => undefined);
});

$("#verify-qr").addEventListener("click", async () => {
  try {
    const payload = await readQrPayload(textarea("#qr-input").value.trim());
    scannedIdentity = payload;
    const knownIdentity = [identityA, identityB].find((identity) => identity?.userId === payload.userId);
    const compared = compareQrIdentity(payload, knownIdentity?.fingerprint);
    $("#trust").textContent = compared.matches
      ? "Fingerprint matches the locally known key. This proves key consistency, not the other person's identity."
      : compared.status === "fingerprint-mismatch"
        ? "WARNING: fingerprint mismatch. Stop and confirm the key through an independent trusted channel."
        : "First use: not independently verified. Confirm the fingerprint through an independent trusted channel before trusting this key.";
  } catch (error) { $("#trust").textContent = error instanceof Error ? error.message : "Invalid QR identity"; }
});

$("#send").addEventListener("click", async () => {
  try {
    if (!identityA || !identityB) throw new Error("Generate both identities first");
    const file = ($("#attachment") as HTMLInputElement).files?.[0];
    const result = await encryptMime(
      [identityA, identityB],
      input("#pass-a").value,
      { subject: input("#subject").value, text: textarea("#message").value, attachments: file ? [file] : [] },
    );
    encryptedMime = result.pgpMime;
    $("#receive").removeAttribute("disabled");
    $("#result").textContent = `Encrypted and signed for ${result.keyFingerprints.length} identities.\nOpenPGP ciphertext length: ${result.ciphertext.length} characters.\n${result.ciphertext.slice(0, 100)}...`;
  } catch (error) { showError(error); }
});

$("#receive").addEventListener("click", async () => {
  try {
    if (!identityA || !identityB) throw new Error("Generate both identities first");
    const decrypted = await decryptMime(identityB, input("#pass-b").value, encryptedMime, identityA);
    $("#result").textContent = `B verified A's signature and decrypted the MIME content:\n\n${decrypted}`;
  } catch (error) { showError(error); }
});

input("#api-send").addEventListener("click", async () => {
  try {
    if (!authA || !authB || !identityA || identityA.userId !== authA.userId) {
      throw new Error("Authenticate A and B and create/import A's matching private key");
    }
    if (!input("#trust-recipient").checked || scannedIdentity?.userId !== authB.userId) {
      throw new Error("Scan B's QR and confirm the full fingerprint through an independent trusted channel first");
    }
    const remote = await apiRequest(`/api/e2ee/keys/${authB.userId}`, {}, authA.token);
    if (remote.key.fingerprint.toUpperCase() !== scannedIdentity.fingerprint) {
      throw new Error("QR key does not match the active server key; stop and confirm out of band");
    }
    const bPublic: LocalIdentity = {
      userId: authB.userId,
      fingerprint: remote.key.fingerprint,
      publicKey: remote.key.publicKey,
      encryptedPrivateKey: "",
    };
    const file = ($("#attachment") as HTMLInputElement).files?.[0];
    const encrypted = await encryptMime(
      [identityA, bPublic],
      input("#pass-a").value,
      { subject: input("#subject").value, text: textarea("#message").value, attachments: file ? [file] : [] },
    );
    const sent = await apiRequest("/api/e2ee/messages", {
      method: "POST",
      headers: { "Idempotency-Key": `browser-${crypto.randomUUID()}` },
      body: JSON.stringify({ to: [authB.userId], cc: [], ciphertext: encrypted.ciphertext, keyFingerprints: encrypted.keyFingerprints }),
    }, authA.token);
    input("#message-id").value = sent.message.messageId;
    input("#api-receive").disabled = false;
    $("#api-result").textContent = `Opaque ciphertext delivered locally as ${sent.message.messageId}. API response contained no plaintext.`;
  } catch (error) { $("#api-result").textContent = error instanceof Error ? error.message : "Send failed"; }
});

input("#api-receive").addEventListener("click", async () => {
  try {
    if (!authB || !identityB || identityB.userId !== authB.userId) {
      throw new Error("Authenticate B and create/import B's matching private key");
    }
    const received = await apiRequest(`/api/e2ee/messages/${input("#message-id").value}`, {}, authB.token);
    const trustedSender = scannedIdentity;
    if (!input("#trust-sender").checked || !trustedSender || trustedSender.userId !== received.message.senderUserId) {
      throw new Error("Scan the sender's QR and confirm the full fingerprint through an independent trusted channel first");
    }
    const sender = await apiRequest(`/api/e2ee/keys/${received.message.senderUserId}/history`, {}, authB.token);
    const signingKeys: LocalIdentity[] = sender.keys.map((key: any) => ({
      userId: received.message.senderUserId,
      fingerprint: key.fingerprint,
      publicKey: key.publicKey,
      encryptedPrivateKey: "",
    }));
    if (!signingKeys.some((key) => key.fingerprint.toUpperCase() === trustedSender.fingerprint)) {
      throw new Error("The scanned sender key is not in the PhoneMail key history; stop and verify the key");
    }
    const content = await decryptMime(identityB, input("#pass-b").value, received.message.ciphertext, signingKeys);
    $("#api-result").textContent = `B authenticated the API response, decrypted the message and verified A's signature:\n\n${content}`;
  } catch (error) { $("#api-result").textContent = error instanceof Error ? error.message : "Receive failed"; }
});

input("#save-draft").addEventListener("click", async () => {
  try {
    if (!authA || !identityA || identityA.userId !== authA.userId) throw new Error("Authenticate A and create/import A's key");
    const encrypted = await encryptMime([identityA], input("#pass-a").value, {
      subject: input("#subject").value, text: textarea("#message").value,
    });
    const result = await apiRequest("/api/e2ee/drafts", {
      method: "POST", body: JSON.stringify({ ciphertext: encrypted.ciphertext }),
    }, authA.token);
    savedDraft = { id: result.draft.id, revision: result.draft.revision };
    input("#send-draft").disabled = !authB || !identityB;
    $("#api-result").textContent = `Encrypted draft ${savedDraft.id} was saved. No message was sent.`;
  } catch (error) { $("#api-result").textContent = error instanceof Error ? error.message : "Draft save failed"; }
});

input("#send-draft").addEventListener("click", async () => {
  try {
    if (!authA || !authB || !identityA || !identityB || !savedDraft) throw new Error("Authenticate both accounts and save a draft first");
    const trustedRecipientQr = scannedIdentity;
    if (!input("#trust-recipient").checked || !trustedRecipientQr || trustedRecipientQr.userId !== authB.userId) {
      throw new Error("Scan B's QR and confirm the full fingerprint through an independent trusted channel first");
    }
    const recipient = await apiRequest(`/api/e2ee/keys/${authB.userId}`, {}, authA.token);
    if (recipient.key.fingerprint.toUpperCase() !== trustedRecipientQr.fingerprint) {
      throw new Error("QR key does not match the active server key; stop and confirm out of band");
    }
    const remote: LocalIdentity = {
      userId: authB.userId, fingerprint: recipient.key.fingerprint,
      publicKey: recipient.key.publicKey, encryptedPrivateKey: "",
    };
    const encrypted = await encryptMime([identityA, remote], input("#pass-a").value, {
      subject: input("#subject").value, text: textarea("#message").value,
    });
    const sent = await apiRequest(`/api/e2ee/drafts/${savedDraft.id}/send`, {
      method: "POST",
      headers: { "Idempotency-Key": `browser-${crypto.randomUUID()}` },
      body: JSON.stringify({
        revision: savedDraft.revision,
        to: [authB.userId],
        cc: [],
        ciphertext: encrypted.ciphertext,
        keyFingerprints: encrypted.keyFingerprints,
      }),
    }, authA.token);
    input("#message-id").value = sent.message.messageId;
    input("#api-receive").disabled = false;
    $("#api-result").textContent = `Draft ${savedDraft.id} sent once as ${sent.message.messageId}.`;
  } catch (error) { $("#api-result").textContent = error instanceof Error ? error.message : "Draft send failed"; }
});
