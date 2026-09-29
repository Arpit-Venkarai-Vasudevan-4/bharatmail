ALTER TABLE sessions ADD COLUMN IF NOT EXISTS family_id UUID;
UPDATE sessions SET family_id=id WHERE family_id IS NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN family_id SET DEFAULT gen_random_uuid();

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_retry_until TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refresh_retry_ciphertext TEXT;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_refresh_hash_format_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_refresh_hash_format_check
  CHECK (
    (refresh_token_hash IS NULL OR refresh_token_hash ~ '^[0-9a-f]{64}$')
    AND (previous_refresh_token_hash IS NULL OR previous_refresh_token_hash ~ '^[0-9a-f]{64}$')
  );

CREATE UNIQUE INDEX IF NOT EXISTS sessions_refresh_token_hash_unique
  ON sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions(family_id,expires_at);
