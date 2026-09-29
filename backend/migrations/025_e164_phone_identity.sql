ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_country TEXT;
ALTER TABLE phone_history ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
ALTER TABLE phone_history ADD COLUMN IF NOT EXISTS phone_country TEXT;
ALTER TABLE telecom_ivr_calls ADD COLUMN IF NOT EXISTS phone_e164 TEXT;
ALTER TABLE telecom_ivr_calls ADD COLUMN IF NOT EXISTS phone_country TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_phone_e164_unique
  ON users(phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS phone_history_phone_e164_unique
  ON phone_history(phone_e164) WHERE phone_e164 IS NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_e164_format_check;
ALTER TABLE users ADD CONSTRAINT users_phone_e164_format_check
  CHECK (
    (phone_e164 IS NULL AND phone_country IS NULL)
    OR (phone_e164 ~ '^\+[1-9][0-9]{7,14}$' AND (phone_country IS NULL OR phone_country ~ '^[A-Z]{2}$'))
  );

ALTER TABLE phone_history DROP CONSTRAINT IF EXISTS phone_history_phone_e164_format_check;
ALTER TABLE phone_history ADD CONSTRAINT phone_history_phone_e164_format_check
  CHECK (
    (phone_e164 IS NULL AND phone_country IS NULL)
    OR (phone_e164 ~ '^\+[1-9][0-9]{7,14}$' AND (phone_country IS NULL OR phone_country ~ '^[A-Z]{2}$'))
  );
