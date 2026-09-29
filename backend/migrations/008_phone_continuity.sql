ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verification_provenance TEXT
  CHECK (phone_verification_provenance IN ('twilio', 'local_mock', 'password', 'unknown'));

CREATE TABLE IF NOT EXISTS phone_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone_normalized TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL UNIQUE,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL DEFAULT 'phone_change'
);
CREATE INDEX IF NOT EXISTS phone_history_user_idx ON phone_history(user_id, retired_at DESC);

CREATE TABLE IF NOT EXISTS account_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_audit_events_user_idx
  ON account_audit_events(user_id, created_at DESC);
