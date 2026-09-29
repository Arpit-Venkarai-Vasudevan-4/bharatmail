import {t,formatDateTime,formatNumber,getLocale} from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { ContactRound, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { ErrorNotice, Empty, Loading, Modal } from '../../components/ui';
import { countries } from '../auth/contracts';
type Contact = { id?: string; userId?: string; address: string; label: string; notes: string; country?: string };
export default function Contacts({ onCompose }: { onCompose: (address: string) => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]), [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Contact | null>(null), [removing, setRemoving] = useState<Contact | null>(null);
  const [error, setError] = useState(''), [formError, setFormError] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false), [more, setMore] = useState(false), [version, setVersion] = useState(0), [offset, setOffset] = useState(0);
  const controller = useRef<AbortController>();
  async function load(offset = 0) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError('');
    try {
      const result = await api<{ contacts: Contact[] }>('/me/contacts?limit=50&offset=' + offset + '&q=' + encodeURIComponent(query), { signal: current.signal });
      if (!current.signal.aborted) { setContacts(result.contacts); setOffset(offset); setMore(result.contacts.length === 50); }
    } catch (e) { if (!current.signal.aborted) setError(errorMessage(e)); }
    finally { if (!current.signal.aborted) setLoading(false); }
  }
  useEffect(() => { const timer = setTimeout(() => void load(), 250); return () => { clearTimeout(timer); controller.current?.abort(); }; }, [query, version]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editing) return; setBusy(true); setFormError('');
    try {
      await api(editing.id ? '/me/contacts/' + editing.id : '/me/contacts', { method: editing.id ? 'PATCH' : 'POST', body: { address: editing.address.trim(), label: editing.label.trim(), notes: editing.notes, ...(editing.country ? { country: editing.country } : {}) } });
      setEditing(null); setVersion(v => v + 1);
    } catch (e) { setFormError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!removing?.id) return; setBusy(true); setFormError('');
    try { await api('/me/contacts/' + removing.id, { method: 'DELETE' }); setRemoving(null); setVersion(v => v + 1); }
    catch (e) { setFormError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="contacts-view">
    <div className="contacts-heading"><div><span className="eyebrow">{t("m_29856afb0fd3")}</span><h1>{t("m_b450645debe2")}<span className="heading-dot">.</span></h1></div><button className="button primary" onClick={() => { setFormError(''); setEditing({ address: '', label: '', notes: '', country: '' }); }}><Plus size={16} /> {t("m_a02ce0df219d")}</button></div>
    <label className="search-field"><Search size={18} /><input type="search" aria-label={t("m_f863aac2492e")} placeholder={t("m_f863aac2492e")} value={query} maxLength={200} onChange={e => setQuery(e.target.value)} /></label>
    {error && <ErrorNotice message={error} retry={() => void load(offset)} />}
    {loading && !contacts.length && <Loading label={t("m_9485587c4eb7")} />}
    {!loading && !error && !contacts.length && <Empty title={query ? t("m_83c30e3e4a7a") : t("m_20e708a4bf22")}><p>{query ? t("m_6149e1f843d1") : t("m_d12d0581e38b")}</p></Empty>}
    <div className="contacts-list">{contacts.map(c => <article className="contact-row" key={c.id}><span className="avatar"><ContactRound size={18} /></span><div><strong>{c.label || c.address}</strong><small>{c.address}</small></div><button className="button quiet compact" onClick={() => onCompose(c.address)}>{t("m_98652afe6ee7")}</button><button className="icon-button" aria-label={t('contact.edit',{address:c.address})} onClick={() => { setFormError(''); setEditing({ ...c, notes: c.notes || '', country: '' }); }}><Pencil size={16} /></button><button className="icon-button" aria-label={t('contact.delete',{address:c.address})} onClick={() => { setFormError(''); setRemoving(c); }}><Trash2 size={16} /></button></article>)}</div>
    <div className="button-row">{offset > 0 && <button className="load-more" disabled={loading} onClick={() => void load(Math.max(0,offset-50))}>{t("recipient.previous")}</button>}{more && <button className="load-more" disabled={loading} onClick={() => void load(offset+50)}>{loading ? t("m_ba3bbbe10d8b") : t("contacts.nextPage")}</button>}</div>
    {editing && <Modal busy={busy} title={editing.id ? t("m_81cd065a45d6") : t("m_a02ce0df219d")} onClose={() => { if (!busy) setEditing(null); }}><form className="settings-view" onSubmit={save}>
      {formError && <div id="contact-error"><ErrorNotice message={formError} /></div>}
      <label>{t("m_af70017e5181")}<input aria-describedby={formError ? "contact-error" : undefined} aria-invalid={!!formError} required value={editing.address} maxLength={320} onChange={e => setEditing({ ...editing, address: e.target.value })} /></label>
      <label>{t("m_adcf53e9f7ec")}<select value={editing.country || ''} onChange={e => setEditing({ ...editing, country: e.target.value })}>{countries().map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></label>
      <label>{t("m_0e66373f45dc")}<input required maxLength={100} value={editing.label} onChange={e => setEditing({ ...editing, label: e.target.value })} /></label>
      <label>{t("m_8a7525b1492f")}<textarea maxLength={1000} value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} /></label>
      <button className="button primary" disabled={busy}>{busy ? t("m_23e39291d613") : t("m_d24f121f4a4e")}</button>
    </form></Modal>}
    {removing && <Modal busy={busy} title={t("m_b7d2d4ce2f03")} onClose={() => { if (!busy) setRemoving(null); }}><div className="settings-view"><p>{t('contact.remove',{name:removing.label||removing.address})}</p>{formError && <div id="contact-error"><ErrorNotice message={formError} /></div>}<div className="button-row"><button className="button danger" disabled={busy} onClick={() => void remove()}>{t("m_f5fed436f9d6")}</button><button className="button quiet" onClick={() => setRemoving(null)} disabled={busy}>{t("m_ae709ac4721f")}</button></div></div></Modal>}
  </div>;
}
