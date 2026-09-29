CREATE TABLE retired_aliases (
  email TEXT PRIMARY KEY,
  retired_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION phonemail_reject_retired_alias_address() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM retired_aliases WHERE email = NEW.email) THEN
    RAISE EXCEPTION 'PhoneMail alias is permanently retired'
      USING ERRCODE = '23505', CONSTRAINT = 'retired_aliases_reserved_email';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS addresses_reject_retired_alias ON addresses;
CREATE TRIGGER addresses_reject_retired_alias
  BEFORE INSERT OR UPDATE OF email ON addresses
  FOR EACH ROW EXECUTE FUNCTION phonemail_reject_retired_alias_address();
