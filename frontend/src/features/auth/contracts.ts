import {t} from '../../i18n';
export type User = { id: string; phone: string; phoneE164: string | null; phoneCountry: string | null; phoneIdentityNeedsCountry: boolean; email: string; displayName: string | null; language: string; profilePictureUrl: string | null; signupChannel: string; hasMobileApp: boolean };
export type ProviderCapability = { supported: boolean; configured: boolean; simulated: boolean; liveTested: boolean };
export type OtpCapabilities = { otpVerification: { sms: ProviderCapability; ivr: ProviderCapability; provider: string; localMock: boolean }; notifications: { sms: ProviderCapability; ivr: ProviderCapability } };
export type Challenge = { challengeId: string; purpose: string; phone: string; phoneE164: string; country: string; expiresAt: string; resendAt?: string; retryAfterSeconds?: number; channel: string };
export type AuthResult = { user: User; token?: string; refreshToken?: string };
export const TERMS_VERSION = 'mvp-1';
export const countries = () => [['', t("m_30b296cb1f81")], ['IN', t("m_08ca9a22267a")], ['BD', t("m_60d12948ae4a")], ['BT', t("m_1d0affb9cb1b")], ['NP', t("m_342326920d1d")], ['LK', t("m_6d5a1102fbe3")], ['PK', t("m_7c784d121b4c")], ['US', t("m_ce5c3821dff9")], ['GB', t("m_0f6c5402c0ec")], ['AE', t("m_e37a25b1c286")], ['SG', t("m_922912017c64")], ['AU', t("m_18e957f33982")], ['CA', t("m_b962fc442538")]];
export function errorText(error: unknown): string { return error instanceof Error ? error.message : t("m_3ccd9d6586ef"); }
export function retryAfter(error: unknown): number { const e = error as { retryAfter?: number | string; fields?: { retryAfter?: string } }; return e?.fields?.retryAfter ? Math.max(0, Number(e.fields.retryAfter)) : Math.ceil(Math.max(0, Number(e?.retryAfter ?? 0)) / 1000); }
export function phonePayload(phone: string, country: string) { return { phone: phone.trim(), ...(country ? { country } : {}) }; }
export function phoneInputValid(phone: string, country: string) { const value=phone.trim();const digits=value.replace(/\D/g,'');return /^[+0-9().\s-]+$/.test(value)&&digits.length>=7&&digits.length<=15&&(Boolean(country)||/^(\+|00)/.test(value)); }
