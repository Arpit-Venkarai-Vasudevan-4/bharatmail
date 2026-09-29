CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  profile_picture_url TEXT,
  signup_channel TEXT NOT NULL DEFAULT 'mobile'
    CHECK (signup_channel IN ('mobile', 'web', 'portal', 'ivr')),
  has_mobile_app BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  is_alias BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX addresses_one_primary_per_user
  ON addresses (user_id)
  WHERE is_primary;

CREATE TABLE aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  address_id UUID NOT NULL UNIQUE REFERENCES addresses (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
  direct_pair_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_direct_key_check CHECK (
    (kind = 'direct' AND direct_pair_key IS NOT NULL)
    OR (kind = 'group' AND direct_pair_key IS NULL)
  )
);

CREATE TABLE conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (conversation_id, email)
);

CREATE INDEX conversation_members_email_idx ON conversation_members (email);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_email TEXT NOT NULL,
  sender_user_id UUID REFERENCES users (id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  in_reply_to_id UUID REFERENCES messages (id) ON DELETE SET NULL,
  folder TEXT NOT NULL DEFAULT 'inbox'
    CHECK (folder IN ('inbox', 'drafts', 'spam', 'trash')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX messages_one_reply_per_parent
  ON messages (in_reply_to_id)
  WHERE in_reply_to_id IS NOT NULL;

CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at DESC);

CREATE TABLE message_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('to', 'cc'))
);

CREATE INDEX message_recipients_message_idx ON message_recipients (message_id);

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachments_message_idx ON attachments (message_id);

CREATE TABLE user_message_state (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_favorite BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, message_id)
);
