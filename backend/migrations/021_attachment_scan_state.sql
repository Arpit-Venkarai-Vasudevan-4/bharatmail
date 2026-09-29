ALTER TABLE uploads
  ADD COLUMN IF NOT EXISTS scanner_state TEXT NOT NULL DEFAULT 'unscanned'
  CHECK (scanner_state IN ('unscanned','pending','clean','rejected'));

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS scanner_state TEXT NOT NULL DEFAULT 'unscanned'
  CHECK (scanner_state IN ('unscanned','pending','clean','rejected'));
