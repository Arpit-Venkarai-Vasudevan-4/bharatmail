import {localizeSystemMessage,t,formatDateTime,formatNumber,getLocale} from '../../i18n';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Bell, Check, LockKeyhole, Shield, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Modal, ErrorNotice, Loading } from '../../components/ui';
import { offlineEnabled, setOfflineEnabled } from '../../lib/storage';
import type { User } from '../mail/types';
import BlockContact from '../../components/BlockContact';
import {ProfileAvatar} from '../../components/ProfileAvatar';
const PhoneChange = lazy(() => import('./PhoneChange'));

type Address = { id: string; email: string; isPrimary: boolean; isAlias: boolean; isActive: boolean };
type Notice = { id: string; eventType: string; createdAt: string; readAt?: string };
type Block = { userId: string };
type Contact = { userId: string; label?: string; address: string };
const securityEventLabels:Record<string,Parameters<typeof t>[0]>={account_created:'m_f63879fd691e',login_succeeded:'m_830abfee3ba8',authentication_failed:'m_93821eb7ce8c',logout:'m_80c6e7caffee',session_renewed:'m_4d55d1d8a058',e2ee_key_changed:'m_30e932ba359b',e2ee_key_revoked_phone_change:'m_35f38a189c15',e2ee_reauthenticated:'m_0df7234b90f3',message_deleted:'m_7e94d4b9a46b',phone_changed:'m_2cd9e6f019d0',phone_proof_accepted:'m_c04bdef73c80',privacy_settings_changed:'m_1d0ff41562c8',security_setting_changed:'m_044d4cc0cd51',alias_created:'m_fa37933880b1',alias_activation_changed:'m_f4d2953d720a',alias_deleted:'m_8d82ce243aa4',credential_replay_detected:'m_0a96ef82c711'};
const preferenceFields = [
  ['discoverable', 'discoverable', "m_9647babb3ae6"],
  ['profileVisible', 'profile_visible', "m_87421998079b"],
  ['readReceipts', 'read_receipts', "m_a338dbd8a316"],
  ['communicationEnabled', 'communication_enabled', "m_1da446cbe479"],
  ['smsEnabled', 'sms_enabled', "m_fb875483f8ed"],
  ['ivrEnabled', 'ivr_enabled', "m_184b7fa4de2c"],
] as const;
export default function Settings({ user, onUserChange, onClose, onSignOut }: { user: User; onUserChange: (u: User) => void; onClose: () => void; onSignOut: () => void }) {
  const [webNotices,setWebNotices]=useState(()=>{try{return localStorage.getItem('phonemail.web-notices:'+user.id)==='true'}catch{return false}});
  const [name, setName] = useState(user.displayName ?? '');
  const [language, setLanguage] = useState(user.language ?? 'en');
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [alias, setAlias] = useState('');
  const [blockId, setBlockId] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const [phoneChange, setPhoneChange] = useState(false);
  const [offline, setOffline] = useState(() => offlineEnabled(user.id));
  const [phonePending, setPhonePending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [errorScope,setErrorScope]=useState('load');
  useEffect(()=>{if(error)document.getElementById('settings-error-'+errorScope)?.scrollIntoView({block:'nearest'})},[error,errorScope]);
  const failure=(scope:string)=>error&&errorScope===scope?<div id={'settings-error-'+scope}><ErrorNotice message={error}/></div>:null;
  const [saved, setSaved] = useState('');
  async function refresh() {
    const results = await Promise.allSettled([
      api<{ preferences: Record<string, boolean> }>('/me/preferences').then(r => setPrefs(r.preferences)),
      api<{ events: Notice[] }>('/me/security-events').then(r => setNotices(r.events)),
      api<{ addresses: Address[] }>('/me/addresses').then(r => setAddresses(r.addresses)),
      api<{ blocks: Block[] }>('/me/blocks').then(r => setBlocks(r.blocks)),
      api<{ contacts: Contact[] }>('/me/contacts?limit=100').then(r => setContacts(r.contacts)),
    ]);
    const failure = results.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  useEffect(() => { void refresh().catch(e => setError(errorMessage(e))); }, [user.id]);
  async function action(work: () => Promise<void>, message: string) {
    setErrorScope((document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-settings-scope]')?.dataset.settingsScope||'load');
    setBusy(true); setError(''); setSaved('');
    try { await work(); setSaved(message); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function savePrefs(key: string, value: boolean) {
    await action(async () => {
      const result = await api<{ preferences: Record<string, boolean> }>('/me/preferences', { method: 'PATCH', body: { [key]: value } });
      setPrefs(result.preferences);
    }, t("m_3490b97459d0"));
  }
  async function picture(file?: File) {
    await action(async () => {
      let result: { user: User };
      if (file) {
        if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) throw new Error(t("m_52f68694a3c4"));
        const { uploadFile } = await import('../../lib/uploads');
        const upload = await uploadFile(file);
        result = await api('/me/profile-picture', { method: 'PUT', body: { uploadId: upload.id } });
      } else result = await api('/me/profile-picture', { method: 'DELETE' });
      onUserChange(result.user);
    }, file ? t("m_5fe9f551fe99") : t("m_07c83598863b"));
  }
  return <Modal busy={busy||phonePending} title={t("m_4aaf6a9dc80d")} onClose={() => { if (!busy && !phonePending) onClose(); }} wide>
    <div className="settings-view">
      <div className="settings-intro"><ProfileAvatar user={user} large/><div><span className="eyebrow">{t("m_4605176093f2")}</span><h3>{user.primaryEmail || user.email || t("m_48353587e69e")}</h3><p>{t("m_7c8147178c9e")}</p></div></div>
      {errorScope==='load'&&error&&<div id="settings-error-load"><ErrorNotice message={error} retry={()=>void action(refresh,t("m_c0135b571d04"))}/></div>}
      {saved && <p className="success-note" role="status"><Check size={14} /> {localizeSystemMessage(saved)}</p>}
      <section className="settings-section" data-settings-scope="profile">{failure('profile')}
        <div className="settings-section-title"><span><Smartphone size={17} />{t("m_d696a35bdd18")}</span><small>{t("m_a11551dd46eb")}</small></div>

        <label>{t("m_2b7f6a84de91")}<input aria-describedby={error&&errorScope==='profile'?'settings-error-profile':undefined} value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
        <button className="button primary" disabled={busy} onClick={() => void action(async () => { const r = await api<{ user: User }>('/me', { method: 'PATCH', body: { displayName: name } }); onUserChange(r.user); }, t("m_ea278dbc0644"))}>{t("m_0c8209e72ec8")}</button>
        <div className="button-row"><label className="file-label">{t("m_50cbb5542838")}<input type="file" accept="image/png,image/jpeg,image/gif" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void picture(file); }} /></label><button className="button outline" disabled={busy || !user.profilePictureUrl} onClick={() => void picture()}>{t("m_1bc6f23b5304")}</button></div>
      </section>
      <section className="settings-section" data-settings-scope="alias">{failure('alias')}
        <div className="settings-section-title"><span>{t("m_882fb8edf90a")}</span><small>{t("m_bfefa6122687")}</small></div>
        {addresses.map(a => <div className="settings-row" key={a.id}><div><strong>{a.email}</strong><small>{a.isPrimary ? t("m_efe10c80ec8a") : a.isActive ? t("m_fde6cedbbfc5") : t("m_0610fd9b8f71")}</small></div>{a.isAlias && <div className="button-row"><button className="button quiet" disabled={busy} onClick={() => void action(async () => { await api('/me/addresses/' + a.id, { method: 'PATCH', body: { active: !a.isActive } }); await refresh(); }, t("m_b48483748297"))}>{a.isActive ? t("m_fb1e6fa55327") : t("m_24433c70eba5")}</button><button className="button quiet danger" disabled={busy} onClick={() => setDeleteId(a.id)}>{t("m_e2d0a54968ea")}</button></div>}
          {deleteId === a.id && <div className="inline-confirm"><p>{t('alias.delete',{address:a.email})}</p><button className="button danger" disabled={busy} onClick={() => void action(async () => { await api('/me/addresses/' + a.id, { method: 'DELETE' }); setDeleteId(''); await refresh(); }, t("m_515ec26af503"))}>{t("m_fa57243dc0dd")}</button><button className="button quiet" onClick={() => setDeleteId('')}>{t("m_e7007a602b44")}</button></div>}
        </div>)}
        <form className="settings-inline" onSubmit={e => { e.preventDefault(); void action(async () => { await api('/me/addresses', { method: 'POST', body: { alias } }); setAlias(''); await refresh(); }, t("m_e6551176a613")); }}><label>{t("m_22cdec079649")}<input aria-describedby={error&&errorScope==='alias'?'settings-error-alias':undefined} value={alias} onChange={e => setAlias(e.target.value)} required minLength={3} maxLength={32} pattern="[a-zA-Z][a-zA-Z0-9._-]{2,31}" placeholder={t("m_eb318564e822")} /></label><button className="button outline" disabled={busy}>{t("m_7fbbfdb34dec")}</button></form>
        <p className="setting-note">{t("m_8dfe03180f35")}</p>
        <button className="button outline" disabled={busy || phonePending} onClick={() => setPhoneChange(!phoneChange)}>{phoneChange ? t("m_d9edb412aefb") : t("m_b40413513157")}</button>
        {phoneChange && <Suspense fallback={<Loading />}><PhoneChange user={user} onPending={setPhonePending} onChanged={u => { onUserChange(u); setPhoneChange(false); void refresh(); setSaved(t("m_00409da9558b")); }} /></Suspense>}
      </section>
      <section className="settings-section" data-settings-scope="prefs">{failure('prefs')}
        <div className="settings-section-title"><span><Bell size={17} />{t("m_18984c14da5f")}</span><small>{t("m_815bf9b39e77")}</small></div>
        <label className="setting-toggle"><span>{t('notice.web')}</span><input type="checkbox" checked={webNotices} onChange={e=>{try{localStorage.setItem('phonemail.web-notices:'+user.id,String(e.target.checked));setWebNotices(e.target.checked)}catch{setErrorScope('prefs');setError(t('notice.failed'))}}}/><i/></label><p className="setting-note">{t('notice.help')}</p>{prefs ? preferenceFields.map(([key, wire, label]) => <label className="setting-toggle" key={key}><span>{t(label)}</span><input type="checkbox" disabled={busy} checked={prefs[wire] === true} onChange={e => void savePrefs(key, e.target.checked)} /><i /></label>) : <p>{t("m_40c64c631ca5")}</p>}
        <p className="setting-note">{t("m_6cb9ba442c1c")}</p>
        <label className="setting-toggle"><span>{t("m_7f8f3d1c344a")}</span><input type="checkbox" checked={user.hasMobileApp === true} disabled={busy} onChange={e => { const present = e.target.checked; void action(async () => { await api('/me/app-presence', { method: 'PUT', body: { present } }); onUserChange({ ...user, hasMobileApp: present }); }, t("m_bb8c08ae4108")); }} /><i /></label>
        <p className="setting-note">{t("m_e98336f0e109")}</p>
      </section>
      <section className="settings-section" data-settings-scope="blocks">{failure('blocks')}
        <div className="settings-section-title"><span>{t("m_0b02e211e1d0")}</span><small>{t('block.knownOnly')}</small></div>
        <BlockContact onChanged={()=>void refresh()}/>
        {blocks.map(b => <div className="settings-row" key={b.userId}><span>{contacts.find(c => c.userId === b.userId)?.label || contacts.find(c => c.userId === b.userId)?.address || t('block.unknown')}</span><button className="button quiet" disabled={busy} onClick={() => void action(async () => { await api('/me/blocks/' + b.userId, { method: 'DELETE' }); await refresh(); }, t("m_929094a5e437"))}>{t("m_712da63171e0")}</button></div>)}
        {!blocks.length && <p className="setting-note">{t("m_2df91f4bbc9f")}</p>}
      </section>
      <section className="settings-section" data-settings-scope="offline">{failure('offline')}
        <div className="settings-section-title"><span><Shield size={17} />{t("m_38b9d88c1fdb")}</span><small>{t("m_d1616c1e5d54")}</small></div>
        <label className="setting-toggle"><span>{t("m_20b8cae494de")}</span><input type="checkbox" checked={offline} disabled={busy} onChange={e => { const value = e.target.checked; void action(async () => { await setOfflineEnabled(user.id, value); setOffline(value); }, value ? t("m_c527572b026b") : t("m_baaadaf28413")); }} /><i /></label>
        <p className="setting-note">{t("m_d6cb9743ee2c")}</p>
      </section>
      <section className="settings-section" data-settings-scope="notices">{failure('notices')}
        <div className="settings-section-title"><span><LockKeyhole size={17} />{t("m_20cf43479ae6")}</span><small>{t("m_6be6f081c79c")}</small></div>
        {notices.map(n => <div className="security-notice" key={n.id}><strong>{t(securityEventLabels[n.eventType]||"m_617ddd6bfe90")}</strong><span>{formatDateTime(n.createdAt)}</span>{!n.readAt && <button disabled={busy} onClick={() => void action(async () => { await api('/me/security-events/' + n.id + '/read', { method: 'PATCH' }); await refresh(); }, t("m_e3df282ac02a"))}>{t("m_b49c9b6cdf43")}</button>}</div>)}
        {!notices.length && <p className="setting-note">{t("m_fcce4df26b97")}</p>}
      </section>
      <button className="button outline" disabled={busy || phonePending} onClick={onSignOut}>{t("m_48f0d3d397d4")}</button>
    </div>
  </Modal>;
}
