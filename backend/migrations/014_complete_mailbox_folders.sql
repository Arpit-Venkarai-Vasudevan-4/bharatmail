ALTER TABLE user_message_state
  DROP CONSTRAINT IF EXISTS user_message_state_folder_check;

ALTER TABLE user_message_state
  ADD CONSTRAINT user_message_state_folder_check
  CHECK (folder IN ('inbox','sent','drafts','trash','archive','spam'));

CREATE INDEX IF NOT EXISTS user_message_state_owner_folder_idx
  ON user_message_state(user_id,folder,message_id);
