ALTER TABLE message_recipients
  ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS message_recipients_user_message_idx
  ON message_recipients(recipient_user_id, message_id);

UPDATE message_recipients mr
   SET recipient_user_id = cm.user_id
  FROM messages m
  JOIN conversation_members cm
    ON cm.conversation_id = m.conversation_id
   AND cm.user_id IS NOT NULL
  WHERE mr.message_id = m.id
    AND mr.email = cm.email
    AND mr.recipient_user_id IS NULL;
