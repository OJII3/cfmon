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

CREATE TABLE IF NOT EXISTS request_nonces (
  public_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (public_key, nonce)
);

CREATE INDEX IF NOT EXISTS request_nonces_expiry ON request_nonces(expires_at);
