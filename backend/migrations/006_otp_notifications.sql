CREATE TABLE IF NOT EXISTS otp_challenges (
  id UUID PRIMARY KEY,
  purpose TEXT NOT NULL,
  phone_normalized TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  provider_request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_challenges_lookup_idx
  ON otp_challenges(phone_normalized, purpose, expires_at);

CREATE TABLE IF NOT EXISTS notification_provider_events (
  id TEXT PRIMARY KEY,
  provider_request_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  status TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS notification_provider_events_request_sequence_idx
  ON notification_provider_events(provider_request_id, sequence);
