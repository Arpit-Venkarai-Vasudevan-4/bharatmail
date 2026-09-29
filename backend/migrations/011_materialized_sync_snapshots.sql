CREATE TABLE IF NOT EXISTS sync_snapshot_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  watermark BIGINT NOT NULL,
  total_records BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sync_snapshot_sessions_owner_expiry_idx
  ON sync_snapshot_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS sync_snapshot_rows (
  snapshot_id UUID NOT NULL REFERENCES sync_snapshot_sessions(id) ON DELETE CASCADE,
  ordinal BIGINT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY(snapshot_id, ordinal)
);

CREATE TABLE IF NOT EXISTS account_sync_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pruned_through_revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
