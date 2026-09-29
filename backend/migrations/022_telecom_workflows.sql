ALTER TABLE users DROP CONSTRAINT IF EXISTS users_signup_channel_check;
ALTER TABLE users ADD CONSTRAINT users_signup_channel_check
  CHECK (signup_channel IN ('mobile','web','portal','ivr','sms'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_verification_provenance_check;
ALTER TABLE users ADD CONSTRAINT users_phone_verification_provenance_check
  CHECK (phone_verification_provenance IN ('twilio','local_mock','password','unknown','twilio_inbound_sms','twilio_inbound_ivr'));

CREATE TABLE IF NOT EXISTS telecom_webhook_events (
  event_key TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS telecom_webhook_events_created_idx
  ON telecom_webhook_events(created_at);

CREATE TABLE IF NOT EXISTS telecom_ivr_calls (
  call_sid TEXT PRIMARY KEY,
  phone_normalized TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status TEXT NOT NULL DEFAULT 'awaiting_consent'
    CHECK (status IN ('awaiting_consent','created','existing','invalid','timed_out','unavailable')),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  consented_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_message_sid TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','accepted','sent','delivered','failed','simulated')),
  status_rank INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id,recipient_user_id)
);
CREATE INDEX IF NOT EXISTS notification_deliveries_status_idx
  ON notification_deliveries(status,updated_at);
