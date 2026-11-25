-- SQLite schema for StreamPay indexer

-- streams table: stream metadata upserted on create/update events
CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    token TEXT NOT NULL,
    deposit TEXT NOT NULL,
    withdrawn TEXT NOT NULL DEFAULT '0',
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    cancelable INTEGER NOT NULL,
    status TEXT NOT NULL,
    cancelled_by TEXT,
    recipient_amount TEXT,
    sender_amount TEXT,
    created_at_ledger INTEGER NOT NULL,
    updated_at_ledger INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_streams_recipient ON streams(recipient);
CREATE INDEX IF NOT EXISTS idx_streams_sender ON streams(sender);

-- events table: append-only log of every processed event
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE NOT NULL,
    stream_id TEXT NOT NULL,
    contract_id TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    ledger_closed_at TEXT,
    tx_hash TEXT,
    event_type TEXT NOT NULL,
    payload JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_stream_id_ledger ON events(stream_id, ledger ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_events_contract_ledger ON events(contract_id, ledger ASC);

-- cursor table: single-row cursor persistence
CREATE TABLE IF NOT EXISTS cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_ledger INTEGER NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- discovery_listings table: public directory index (coarsened, allowlisted attributes only)
CREATE TABLE IF NOT EXISTS discovery_listings (
    listing_id TEXT PRIMARY KEY,
    asset TEXT NOT NULL,
    rate_bucket TEXT NOT NULL,
    duration_bucket TEXT NOT NULL,
    status TEXT NOT NULL,
    state TEXT NOT NULL, -- 'PUBLISHED', 'WITHDRAWN'
    listed_day TEXT NOT NULL, -- YYYY-MM-DD
    created_at INTEGER NOT NULL,
    withdrawn_at INTEGER,
    sender TEXT,     -- NULL unless both opted in
    recipient TEXT,  -- NULL unless both opted in
    verification_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_listings_eq_class
    ON discovery_listings(asset, rate_bucket, duration_bucket, state);

-- discovery_consent_vault table: private segregated consent proofs and signatures
-- strictly segregated from public browse queries
CREATE TABLE IF NOT EXISTS discovery_consent_vault (
    listing_id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    deposit_raw TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    sender_signature TEXT NOT NULL,
    sender_share_address INTEGER NOT NULL,
    recipient_signature TEXT NOT NULL,
    recipient_share_address INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    expiry INTEGER NOT NULL,
    FOREIGN KEY(listing_id) REFERENCES discovery_listings(listing_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_vault_stream ON discovery_consent_vault(stream_id);

-- discovery_nonces table: replay prevention across proposals and withdrawals
CREATE TABLE IF NOT EXISTS discovery_nonces (
    nonce TEXT PRIMARY KEY,
    consumed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


