import { t } from '../../i18n';

export type Delivery = {
  lifecycleStatus: string;
  recipients: { email: string; role: 'to' | 'cc'; status: string; is_read: boolean | null }[];
};

export default function DeliveryStatus({ delivery }: { delivery: Delivery }) {
  const statuses: Record<string, string> = {
    draft: t("m_ebf12ef47cf5"),
    committed: t("m_81cca29e4ad7"),
    local_committed: t("m_ce6738564ea0"),
    provider_accepted: t("m_0bdd45fabeba"),
    provider_delivered: t("m_0edfaa01d91b"),
    failed: t("m_031a8f0f659d"),
    rejected: t("m_aea4a04a8042"),
    queued: t("m_661ff40a07e0"),
    retrying: t("m_f8fe6f863109"),
    relay_accepted: t("m_9be795ab4223"),
    simulated: t("m_7589de4e3b9d"),
    acceptance_unknown: t("m_34c7d0ced574"),
  };
  const label = (status: string) => statuses[status] || t('m_617ddd6bfe90');
  return <div className="delivery-summary">
    <p><strong>{t("m_28a740b3053f")}</strong>: {label(delivery.lifecycleStatus)}</p>
    {!delivery.recipients.length && <p>{t("m_02142dfac8bb")}</p>}
    {delivery.recipients.map(recipient => <section className="settings-section" key={recipient.role + ':' + recipient.email}>
      <strong className="delivery-recipient">{recipient.role === 'cc' ? t('m_b28037e918b6') : t('m_f4b06ef6d3c8')}: {recipient.email}</strong>
      <p>{label(recipient.status)}</p>
      <p>{recipient.is_read === null ? t("m_0576c78a2e61") : recipient.is_read ? t("m_9b9a8d05a7ec") : t("m_6e55584aeca0")}</p>
    </section>)}
  </div>;
}
