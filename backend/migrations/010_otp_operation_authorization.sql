ALTER TABLE otp_challenges
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'legacy_unknown',
  ADD COLUMN IF NOT EXISTS verification_state TEXT NOT NULL DEFAULT 'issued'
    CHECK (verification_state IN ('issued', 'checking', 'authorized', 'ambiguous', 'used', 'failed')),
  ADD COLUMN IF NOT EXISTS verification_started_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS otp_operation_authorizations (
  challenge_id UUID PRIMARY KEY REFERENCES otp_challenges(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  purpose TEXT NOT NULL,
  account_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_operation_authorizations_expiry_idx
  ON otp_operation_authorizations(expires_at);

CREATE TABLE IF NOT EXISTS otp_send_limits (
  phone_normalized TEXT NOT NULL,
  purpose TEXT NOT NULL,
  last_reserved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (phone_normalized, purpose)
);

UPDATE otp_challenges
SET provider = CASE
  WHEN provider_request_id LIKE 'local-%' THEN 'local_mock'
  ELSE 'legacy_unknown'
END
WHERE provider = 'legacy_unknown';
