CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id, expires_at);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'message_recipients'
      AND constraint_name = 'message_recipients_role_check'
  ) THEN
    ALTER TABLE message_recipients DROP CONSTRAINT message_recipients_role_check;
  END IF;
END $$;

ALTER TABLE message_recipients
  ADD CONSTRAINT message_recipients_role_check CHECK (role IN ('to', 'cc'));
