CREATE INDEX IF NOT EXISTS account_audit_events_retention_idx
  ON account_audit_events(created_at);

CREATE TABLE IF NOT EXISTS security_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL UNIQUE REFERENCES account_audit_events(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS security_notifications_owner_created_idx
  ON security_notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS security_notifications_retention_idx
  ON security_notifications(created_at);
