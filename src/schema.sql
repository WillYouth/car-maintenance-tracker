-- Car Maintenance Tracker schema (SQLite). Applied idempotently on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'driver')),
  active        INTEGER NOT NULL DEFAULT 1,            -- soft delete keeps history intact
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,                         -- sha256 of the cookie token, never the raw token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL                          -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS vehicles (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  plate             TEXT UNIQUE,
  odometer_km       INTEGER NOT NULL DEFAULT 0,
  next_service_km   INTEGER,
  next_service_date TEXT,                              -- YYYY-MM-DD
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id                 INTEGER PRIMARY KEY,
  vehicle_id         INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_id          INTEGER NOT NULL REFERENCES users(id),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  mileage_difference INTEGER,                          -- after.mileage - before.mileage
  started_at         TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_rides_vehicle_started ON rides(vehicle_id, started_at DESC);
-- At most one open ride per driver per vehicle; also serves as the "find open ride" lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rides_open ON rides(driver_id, vehicle_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS ride_snapshots (
  id                 INTEGER PRIMARY KEY,
  ride_id            INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  phase              TEXT NOT NULL CHECK (phase IN ('before', 'after')),
  mileage            INTEGER,
  fuel_percentage    INTEGER CHECK (fuel_percentage BETWEEN 0 AND 100),
  engine_temp_status TEXT CHECK (engine_temp_status IN ('normal', 'high')),
  warning_lights     TEXT NOT NULL DEFAULT '[]',       -- JSON array of strings
  photo_file         TEXT,                             -- file name inside UPLOAD_DIR
  source             TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ride_id, phase)
);

CREATE TABLE IF NOT EXISTS maintenance (
  id               INTEGER PRIMARY KEY,
  vehicle_id       INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_id        INTEGER NOT NULL REFERENCES users(id),
  service_date     TEXT,                               -- YYYY-MM-DD
  odometer_km      INTEGER,
  total_cost_cents INTEGER,
  currency         TEXT,                               -- ISO 4217
  items            TEXT NOT NULL DEFAULT '[]',         -- JSON: [{description, category, cost}]
  invoice_file     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle_date ON maintenance(vehicle_id, service_date DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_driver       ON maintenance(driver_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
