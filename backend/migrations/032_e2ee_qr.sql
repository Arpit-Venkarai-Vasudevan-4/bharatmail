ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS reauthenticated_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_format TEXT NOT NULL DEFAULT 'plain'
    CHECK (content_format IN ('plain', 'openpgp-v1'));

CREATE TABLE e2ee_key_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('enroll', 'rotate', 'revoke')),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX e2ee_key_challenges_expiry_idx ON e2ee_key_challenges(expires_at);

CREATE TABLE e2ee_public_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL UNIQUE,
  encryption_key_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX e2ee_one_active_key_per_user_idx
  ON e2ee_public_keys(user_id) WHERE revoked_at IS NULL;
CREATE INDEX e2ee_public_keys_user_history_idx
  ON e2ee_public_keys(user_id, created_at DESC);

CREATE TABLE e2ee_messages (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  key_fingerprints JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE idempotency_keys DROP CONSTRAINT IF EXISTS idempotency_keys_resource_type_check;
ALTER TABLE idempotency_keys
  ADD CONSTRAINT idempotency_keys_resource_type_check
  CHECK (resource_type IN ('conversation', 'message', 'e2ee_message'));

CREATE TABLE e2ee_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  sent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX e2ee_drafts_user_updated_idx ON e2ee_drafts(user_id, updated_at DESC);
