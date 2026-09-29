ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT,
  ADD COLUMN IF NOT EXISTS references_header TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS envelope_from TEXT,
  ADD COLUMN IF NOT EXISTS header_from TEXT,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS messages_rfc_message_id_idx
  ON messages(rfc_message_id) WHERE rfc_message_id IS NOT NULL AND sender_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS smtp_message_deliveries (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('to','cc')),
  status TEXT NOT NULL CHECK (status IN ('queued','retrying','relay_accepted','simulated','failed','acceptance_unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS smtp_message_deliveries_status_idx
  ON smtp_message_deliveries(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inbound_mail_dedup (
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deduplication_key TEXT NOT NULL,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_user_id, deduplication_key)
);
CREATE INDEX IF NOT EXISTS inbound_mail_dedup_retention_idx
  ON inbound_mail_dedup(received_at);
