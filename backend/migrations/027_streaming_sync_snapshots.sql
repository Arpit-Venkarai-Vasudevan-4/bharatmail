ALTER TABLE sync_snapshot_sessions
  ADD COLUMN IF NOT EXISTS snapshot_mode TEXT NOT NULL DEFAULT 'materialized';
ALTER TABLE sync_snapshot_sessions
  ADD COLUMN IF NOT EXISTS owner_instance UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE sync_snapshot_sessions DROP CONSTRAINT IF EXISTS sync_snapshot_mode_check;
ALTER TABLE sync_snapshot_sessions ADD CONSTRAINT sync_snapshot_mode_check
  CHECK (snapshot_mode IN ('materialized','streaming'));

CREATE INDEX IF NOT EXISTS sync_snapshot_streaming_owner_idx
  ON sync_snapshot_sessions(owner_instance,expires_at)
  WHERE snapshot_mode='streaming';

CREATE INDEX IF NOT EXISTS addresses_sync_owner_id_idx ON addresses(user_id,id);
CREATE INDEX IF NOT EXISTS drafts_sync_owner_id_idx ON drafts(user_id,id);
CREATE INDEX IF NOT EXISTS contacts_sync_owner_id_idx ON contacts(owner_user_id,id);
CREATE INDEX IF NOT EXISTS conversation_members_sync_owner_idx ON conversation_members(user_id,conversation_id);
CREATE INDEX IF NOT EXISTS messages_sync_conversation_id_idx ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS uploads_sync_owner_id_idx ON uploads(user_id,id) WHERE status IN ('staged','ready');
