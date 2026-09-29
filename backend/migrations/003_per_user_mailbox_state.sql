ALTER TABLE user_message_state
  ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'inbox';

ALTER TABLE user_message_state
  DROP CONSTRAINT IF EXISTS user_message_state_folder_check;

ALTER TABLE user_message_state
  ADD CONSTRAINT user_message_state_folder_check
  CHECK (folder IN ('inbox', 'drafts', 'spam', 'trash'));

CREATE INDEX IF NOT EXISTS user_message_state_mailbox_idx
  ON user_message_state (user_id, folder, is_read, is_favorite);
