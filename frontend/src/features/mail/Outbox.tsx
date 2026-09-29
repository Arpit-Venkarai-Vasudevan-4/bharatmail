import {t,formatDateTime,formatNumber,getLocale} from '../../i18n';
import { useEffect, useState } from 'react';
import { Modal, ErrorNotice } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { discardOperation, listOperations, processOperation, type Operation } from '../../lib/outbox';

export default function Outbox({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<Operation[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState('');
  async function refresh() { setItems(await listOperations(userId)); }
  useEffect(() => { const update = () => void refresh().catch(e => setError(errorMessage(e))); update(); window.addEventListener('phonemail:outbox', update); return () => window.removeEventListener('phonemail:outbox', update); }, [userId]);
  async function run(item: Operation, discard = false) {
    setBusy(item.key); setError('');
    try { if (discard) await discardOperation(userId, item.key); else { await processOperation(userId, item.key); onChanged(); } await refresh(); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(''); }
  }
  return <Modal title={t("m_2c2846b7cc24")} onClose={onClose} wide><div className="settings-view">
    <p>{t("m_0606c5bac1ca")}</p>
    <p className="setting-note">{t("m_d931461a555b")}</p>
    {error && <ErrorNotice message={error} />}
    {!items.length && <p>{t("m_dc576c0dd559")}</p>}
    {items.map(item => <section className="settings-section" key={item.key}><strong>{item.state === 'sent' ? t("m_81cca29e4ad7") : item.state === 'unknown' ? t("m_164557364fc9") : item.state === 'failed' ? t("m_22b35abf1959") : item.state === 'expired' ? t("m_c24006023488") : t("m_49559a342853")}</strong><p>{formatDateTime(item.createdAt)}</p>{item.error && <p>{item.error}</p>}<div className="button-row">{item.state !== 'sent' && <button className="button outline" disabled={!!busy} onClick={() => void run(item)}>{busy === item.key ? t("m_ec963ffc911b") : t("m_d11c3bdd9ea4")}</button>}{(['sent', 'failed'].includes(item.state) || (item.state === 'queued' && item.attempts === 0)) && <button className="button quiet" disabled={!!busy} onClick={() => void run(item, true)}>{t("m_4234755d5171")}</button>}</div></section>)}
  </div></Modal>;
}
