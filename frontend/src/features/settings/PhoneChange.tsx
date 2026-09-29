import {t,formatDateTime,formatNumber,getLocale} from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage, setAccountChangePending, setSessionState } from '../../lib/api';
import PhoneField from '../auth/PhoneField';
import type { Challenge, OtpCapabilities } from '../auth/contracts';
import type { User } from '../mail/types';
import { ErrorNotice } from '../../components/ui';

export default function PhoneChange({ user, onChanged, onPending }: { user: User; onChanged: (user: User) => void; onPending?: (pending: boolean) => void }) {
  const [phone, setPhone] = useState(''), [country, setCountry] = useState('');
  const [password, setPassword] = useState(''), [otpOnly, setOtpOnly] = useState(false);
  const [challenge, setChallenge] = useState<Challenge>(), [oldChallenge, setOldChallenge] = useState<Challenge>();
  const [code, setCode] = useState(''), [oldCode, setOldCode] = useState('');
  const [capability, setCapability] = useState<OtpCapabilities>();
  const [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0), [accepted, setAccepted] = useState(false);
  const completed = useRef(false);
  const exact = useRef<{ key: string; body: Record<string, unknown>; started: number; phoneE164: string }>();
  useEffect(() => { void api<OtpCapabilities>('/otp/capabilities', { auth: false }).then(setCapability).catch(e => setError(errorMessage(e))); }, []);
  useEffect(() => { const timer = setInterval(() => setCooldown(v => Math.max(0, v - 1)), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { const pending=!completed.current&&(busy||unknown);onPending?.(pending);setAccountChangePending(pending); }, [busy, unknown]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (exact.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function requestCode(old = false) {
    setBusy(true); setError('');
    try {
      const r = await api<Challenge>('/otp/request', { method: 'POST', auth: false, body: {
        phone: old ? user.phoneE164 || user.phone : phone.trim(),
        ...(old ? user.phoneCountry ? { country: user.phoneCountry } : {} : country ? { country } : {}),
        purpose: old ? 'phone_change_old' : 'phone_change', channel: 'sms',
      } });
      if (old) { setOldChallenge(r); setOldCode(''); } else { setChallenge(r); setCode(''); }
      setCooldown(60);
    } catch (e) { setError(errorMessage(e)); if (e instanceof ApiError) setCooldown(Math.ceil(e.retryAfter / 1000)); }
    finally { setBusy(false); }
  }
  async function changed(next: User) {
    if (next.id !== user.id) throw new Error(t("m_7915e6489a0b"));
    completed.current=true; exact.current = undefined; setUnknown(false); setPassword(''); setCode(''); setOldCode('');
    setAccountChangePending(false); setSessionState('authenticated');
    const { lockKeys } = await import('../security/service'); lockKeys(); onPending?.(false); onChanged(next);
  }
  async function submit() {
    setBusy(true); setError('');
    try {
      if (!exact.current) {
        if (!challenge || !code || !accepted || (otpOnly ? !oldChallenge || !oldCode : !password)) throw new Error(t("m_0aaa4753cbce"));
        if (Date.parse(challenge.expiresAt) <= Date.now() || (otpOnly && Date.parse(oldChallenge!.expiresAt) <= Date.now())) throw new Error(t("m_678a30001809"));
        exact.current = { key: crypto.randomUUID(), started: Date.now(), phoneE164: challenge.phoneE164, body: {
          newPhone: phone.trim(), ...(country ? { country } : {}), challengeId: challenge.challengeId, code,
          ...(otpOnly ? { oldChallengeId: oldChallenge!.challengeId, oldCode } : { currentPassword: password }),
        } };
      } else {
        // A lost body may still have applied replacement cookies. Check them without rotating the original session.
        const current = await api<{ user: User }>('/auth/me', { auth: false, refresh: false }).catch(e => { if (e.status === 401) return null; throw e; });
        if (current?.user.id === user.id && current.user.phoneE164 === exact.current.phoneE164) { await changed(current.user); return; }
      }
      if (Date.now() - exact.current.started >= 14 * 60_000) throw new Error(t("m_df7754bc9d11"));
      const result = await api<{ user: User }>('/auth/phone-change', { method: 'POST', auth: false, refresh: false, headers: { 'Idempotency-Key': exact.current.key }, body: exact.current.body });
      await changed(result.user);
    } catch (e) {
      const ambiguous = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
      setUnknown(ambiguous);
      if (!ambiguous) exact.current = undefined;
      setError(ambiguous ? t('phone.unknown',{error:errorMessage(e)}) : errorMessage(e));
    } finally { setBusy(false); }
  }
  const sms = capability?.otpVerification.sms;
  return <div className="phone-change-form">
    <p>{t("m_87d06b050f36")}</p>
    {sms?.simulated && <p className="setting-note">{t("m_d36ac29635ba")}</p>}
    {capability && !sms?.configured && !sms?.simulated && <p className="error-notice">{t("m_7a191f5374c3")}</p>}
    {error && <ErrorNotice message={error} />}
    <fieldset disabled={busy || unknown}>
      <PhoneField phone={phone} country={country} onPhone={v => { setPhone(v); setChallenge(undefined); }} onCountry={v => { setCountry(v); setChallenge(undefined); }} id="new-phone" label={t("m_7b54e7f37801")} />
      <button type="button" className="button outline" disabled={!phone || cooldown > 0 || !sms?.supported || !(sms.configured || sms.simulated)} onClick={() => void requestCode()}>{challenge ? t("m_4d8cefaf9e46") : t("m_9828e8a0d8cb")}{cooldown > 0 ? t("m_24d8be871928",{value0:cooldown}) : ''}</button>
      {challenge && <label>{t("m_75c5c7fb0814")}<input aria-label={t("m_75c5c7fb0814")} aria-describedby="new-code-expiry" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} maxLength={12} /><small id="new-code-expiry">{t('auth.expires',{time:formatDateTime(challenge.expiresAt,{timeStyle:'short'})})}</small></label>}
      <label className="check-row"><input type="checkbox" checked={otpOnly} onChange={e => setOtpOnly(e.target.checked)} />{t("m_c2f3498e3c22")}</label>
      {otpOnly ? <><p>{t('phone.oldProof',{phone:String(user.phoneE164||user.phone||'')})}</p><button type="button" className="button outline" disabled={cooldown > 0 || !sms?.supported || !(sms.configured || sms.simulated)} onClick={() => void requestCode(true)}>{t("m_2f53e012357b")}</button>{oldChallenge && <label>{t("m_dccd15987d23")}<input inputMode="numeric" autoComplete="one-time-code" value={oldCode} onChange={e => setOldCode(e.target.value)} maxLength={12} /></label>}</> : <label>{t("m_65b113c7a7b7")}<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>}
      <label className="check-row"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />{t("m_1cd4c9f1fc39")}</label>
    </fieldset>
    <button type="button" className="button primary" disabled={busy || (!unknown && (!accepted || !challenge || !code))} onClick={() => void submit()}>{busy ? t("m_ec963ffc911b") : unknown ? t("m_2faaa080c894") : t("m_9ed5a0c62910")}</button>
    <p className="setting-note">{t("m_c02b14e43425")}</p>
  </div>;
}
