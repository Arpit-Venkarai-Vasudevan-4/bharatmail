CREATE TABLE IF NOT EXISTS phone_change_recoveries (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  old_session_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  old_token_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_ciphertext TEXT NOT NULL,
  response_iv TEXT NOT NULL,
  response_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (old_session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS phone_change_recoveries_expiry_idx
  ON phone_change_recoveries(expires_at);
