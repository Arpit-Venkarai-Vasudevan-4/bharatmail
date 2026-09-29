CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx
  ON auth_rate_limits(window_started_at);

CREATE INDEX IF NOT EXISTS otp_phone_rate_limits_window_idx
  ON otp_phone_rate_limits(window_started_at);
CREATE INDEX IF NOT EXISTS otp_ip_rate_limits_window_idx
  ON otp_ip_rate_limits(window_started_at);
CREATE INDEX IF NOT EXISTS otp_send_limits_reserved_idx
  ON otp_send_limits(last_reserved_at);
