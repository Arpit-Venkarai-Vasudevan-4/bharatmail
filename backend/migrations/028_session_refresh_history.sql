CREATE TABLE IF NOT EXISTS session_refresh_tokens (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  used_at TIMESTAMPTZ,
  retry_until TIMESTAMPTZ,
  retry_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(session_id,generation),
  CHECK (
    (used_at IS NULL AND retry_until IS NULL AND retry_ciphertext IS NULL)
    OR (used_at IS NOT NULL AND retry_until IS NOT NULL AND retry_ciphertext IS NOT NULL)
  )
);

INSERT INTO session_refresh_tokens(token_hash,session_id,generation)
SELECT refresh_token_hash,id,0 FROM sessions
WHERE refresh_token_hash IS NOT NULL
ON CONFLICT(token_hash) DO NOTHING;

CREATE INDEX IF NOT EXISTS session_refresh_tokens_session_generation_idx
  ON session_refresh_tokens(session_id,generation DESC);
