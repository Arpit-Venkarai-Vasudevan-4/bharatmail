DROP INDEX IF EXISTS messages_rfc_message_id_idx;

CREATE UNIQUE INDEX messages_rfc_message_id_idx
  ON messages(rfc_message_id)
  WHERE rfc_message_id IS NOT NULL AND sender_user_id IS NOT NULL;
