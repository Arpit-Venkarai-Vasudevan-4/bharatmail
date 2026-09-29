CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS otp_challenges_expiry_idx ON otp_challenges(expires_at);
CREATE INDEX IF NOT EXISTS sync_snapshot_expiry_idx ON sync_snapshot_sessions(expires_at);
CREATE INDEX IF NOT EXISTS telecom_webhook_events_completed_idx ON telecom_webhook_events(completed_at);
CREATE INDEX IF NOT EXISTS outbox_jobs_status_created_idx ON outbox_jobs(status,created_at);
