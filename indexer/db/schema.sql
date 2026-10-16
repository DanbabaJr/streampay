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

