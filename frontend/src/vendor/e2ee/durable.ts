import {t} from '../../i18n';
/** Narrow browser extension of the supplied PhoneMail client. Records contain ciphertext only. */
import * as openpgp from 'openpgp';
import { signChallenge, type LocalIdentity } from './index';
import type { PreparedEncryptedMessage, PreparedEncryptedDraftSend } from './client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FP = /^(?:[A-F0-9]{40}|[A-F0-9]{64})$/;
// Be conservative: stop before the backend's 24-hour idempotency window, never mint a replacement key.
export const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export type DurablePrepared = {
  version: 1; kind: 'message' | 'draft'; userId: string; fingerprint: string;
  createdAt: number; prepared: PreparedEncryptedMessage | PreparedEncryptedDraftSend; signature: string;
};
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error(t("m_6cb53a63fe56"));
}
function assertRecord(value: unknown): asserts value is DurablePrepared {
  if (!plain(value)) throw new Error(t("m_8def54410bd2"));
  exact(value, ['version','kind','userId','fingerprint','createdAt','prepared','signature']);
  if (value.version !== 1 || !['message','draft'].includes(String(value.kind)) || typeof value.userId !== 'string' || !UUID.test(value.userId) || typeof value.fingerprint !== 'string' || !FP.test(value.fingerprint) || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || typeof value.signature !== 'string' || value.signature.length > 32768 || !plain(value.prepared)) throw new Error(t("m_8dd66460f405"));
  const p = value.prepared;
  exact(p, value.kind === 'draft' ? ['to','cc','ciphertext','keyFingerprints','idempotencyKey','draftId','revision'] : ['to','cc','ciphertext','keyFingerprints','idempotencyKey','replyToId']);
  if (!Array.isArray(p.to) || !Array.isArray(p.cc) || !p.to.length || p.to.length + p.cc.length > 49) throw new Error(t("m_1bde58d03e0e"));
  const ids = [...p.to, ...p.cc];
  if (ids.some(id => typeof id !== 'string' || !UUID.test(id) || id === value.userId) || new Set(ids).size !== ids.length) throw new Error(t("m_8e4c1735a067"));
  if (typeof p.ciphertext !== 'string' || p.ciphertext.length > 14 * 1024 * 1024 || !p.ciphertext.startsWith('-----BEGIN PGP MESSAGE-----') || !p.ciphertext.endsWith('-----END PGP MESSAGE-----') || typeof p.idempotencyKey !== 'string' || !/^[\x20-\x7e]{8,128}$/.test(p.idempotencyKey)) throw new Error(t("m_ae637a557f6c"));
  if (!Array.isArray(p.keyFingerprints) || p.keyFingerprints.length !== ids.length + 1 || p.keyFingerprints.some(fp => typeof fp !== 'string' || !FP.test(fp)) || new Set(p.keyFingerprints).size !== p.keyFingerprints.length || !p.keyFingerprints.includes(value.fingerprint)) throw new Error(t("m_e01c668a3d07"));
  if (p.replyToId !== undefined && (typeof p.replyToId !== 'string' || !UUID.test(p.replyToId))) throw new Error(t("m_94d807063104"));
  if (value.kind === 'draft' && (typeof p.draftId !== 'string' || !UUID.test(p.draftId) || typeof p.revision !== 'number' || !Number.isSafeInteger(p.revision) || p.revision < 1)) throw new Error(t("m_71a4e03ea99f"));
}
function signedText(record: Omit<DurablePrepared,'signature'>) {
  // Fixed field order; preserve every original payload array and ciphertext byte.
  const p = record.prepared;
  return JSON.stringify({ version: record.version, kind: record.kind, userId: record.userId, fingerprint: record.fingerprint, createdAt: record.createdAt, prepared: { to: p.to, cc: p.cc, ciphertext: p.ciphertext, keyFingerprints: p.keyFingerprints, idempotencyKey: p.idempotencyKey, ...(p.replyToId ? {replyToId:p.replyToId}:{}), ...('draftId' in p ? {draftId:p.draftId, revision:p.revision}:{}) }});
}
export async function signPrepared(kind: DurablePrepared['kind'], prepared: DurablePrepared['prepared'], identity: LocalIdentity, passphrase: string): Promise<DurablePrepared> {
  const unsigned = {version:1 as const, kind, userId:identity.userId, fingerprint:identity.fingerprint, createdAt:Date.now(), prepared};
  const record = {...unsigned, signature:await signChallenge(identity, passphrase, signedText(unsigned))};
  assertRecord(record);
  return record;
}
export async function restoreSignedPrepared(value: unknown, identity: LocalIdentity) {
  assertRecord(value);
  if (value.userId !== identity.userId || value.fingerprint !== identity.fingerprint) throw new Error(t("m_15117e2a8d6c"));
  if (value.createdAt > Date.now() + 60_000 || Date.now() - value.createdAt >= RETRY_WINDOW_MS) throw new Error(t("m_6ef8fe29676c"));
  const key = await openpgp.readKey({armoredKey:identity.publicKey});
  if (key.getFingerprint().toUpperCase() !== value.fingerprint) throw new Error(t("m_f84bb271ad7b"));
  const checked = await openpgp.verify({message:await openpgp.createMessage({text:signedText(value)}), signature:await openpgp.readSignature({armoredSignature:value.signature}), verificationKeys:key});
  if (checked.signatures.length !== 1 || !(await checked.signatures[0].verified)) throw new Error(t("m_f5133460a6a7"));
  await openpgp.readMessage({armoredMessage:value.prepared.ciphertext});
  const p = value.prepared;
  const prepared = Object.freeze({...p, to:Object.freeze([...p.to]), cc:Object.freeze([...p.cc]), keyFingerprints:Object.freeze([...p.keyFingerprints])});
  return {kind:value.kind, prepared};
}
