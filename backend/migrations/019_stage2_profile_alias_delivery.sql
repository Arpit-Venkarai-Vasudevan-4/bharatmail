ALTER TABLE addresses
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_picture_upload_id UUID REFERENCES uploads(id) ON DELETE SET NULL;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('active','disabled','suspended'));

CREATE INDEX IF NOT EXISTS addresses_user_active_idx
  ON addresses(user_id,is_active,is_primary);

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'committed'
  CHECK (lifecycle_status IN ('draft','committed','failed'));

CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('local_committed','provider_accepted','provider_delivered','failed','rejected')),
  provider TEXT,
  provider_reference TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(message_id,recipient_user_id)
);
CREATE INDEX IF NOT EXISTS message_deliveries_recipient_status_idx
  ON message_deliveries(recipient_user_id,status,updated_at DESC);
