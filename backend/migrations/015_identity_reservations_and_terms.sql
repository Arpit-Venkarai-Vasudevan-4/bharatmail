ALTER TABLE users
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version TEXT;

CREATE OR REPLACE FUNCTION phonemail_reject_retired_address() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  local_part TEXT;
BEGIN
  local_part := split_part(NEW.email, '@', 1);
  IF local_part ~ '^[0-9]{10,15}$' THEN
    PERFORM pg_advisory_xact_lock(hashtext('phonemail.phone_identity:' || local_part));
  END IF;
  IF EXISTS (
    SELECT 1 FROM phone_history
     WHERE address = NEW.email OR phone_normalized = local_part
  ) THEN
    RAISE EXCEPTION 'PhoneMail address is permanently reserved'
      USING ERRCODE = '23505', CONSTRAINT = 'phone_history_reserved_address';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION phonemail_reject_retirement_with_live_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('phonemail.phone_identity:' || NEW.phone_normalized));
  IF EXISTS (SELECT 1 FROM addresses WHERE email = NEW.address) THEN
    RAISE EXCEPTION 'PhoneMail address is still assigned'
      USING ERRCODE = '23505', CONSTRAINT = 'phone_history_live_address';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS addresses_reject_retired_phone ON addresses;
CREATE TRIGGER addresses_reject_retired_phone
  BEFORE INSERT OR UPDATE OF email ON addresses
  FOR EACH ROW EXECUTE FUNCTION phonemail_reject_retired_address();

DROP TRIGGER IF EXISTS phone_history_reject_live_address ON phone_history;
CREATE TRIGGER phone_history_reject_live_address
  BEFORE INSERT OR UPDATE OF phone_normalized, address ON phone_history
  FOR EACH ROW EXECUTE FUNCTION phonemail_reject_retirement_with_live_address();
