CREATE TABLE IF NOT EXISTS agents (
  public_key TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  host TEXT NOT NULL,
  os TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
  last_requested_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_one_approved_per_host
  ON agents(host) WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS agents_status_requested
  ON agents(status, last_requested_at);
