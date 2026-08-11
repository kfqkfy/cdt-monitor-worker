-- CDT-Monitor Worker 数据库结构 (Cloudflare D1)
-- 与原版 SQLite 结构对应

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  access_key_id TEXT,
  access_key_secret TEXT,
  region_id TEXT,
  instance_id TEXT,
  max_traffic REAL,
  schedule_enabled INTEGER DEFAULT 0,
  start_time TEXT,
  stop_time TEXT,
  traffic_used REAL DEFAULT 0,
  instance_status TEXT DEFAULT 'Unknown',
  updated_at INTEGER DEFAULT 0,
  last_keep_alive_at INTEGER DEFAULT 0,
  remark TEXT DEFAULT '',
  site_type TEXT DEFAULT 'china'
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  message TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_type_created ON logs (type, created_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT,
  attempt_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_login_ip_time ON login_attempts (ip, attempt_time);

CREATE TABLE IF NOT EXISTS traffic_hourly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  traffic REAL,
  recorded_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_hourly_unique ON traffic_hourly (account_id, recorded_at);

CREATE TABLE IF NOT EXISTS traffic_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  traffic REAL,
  recorded_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traffic_daily_unique ON traffic_daily (account_id, recorded_at);

CREATE TABLE IF NOT EXISTS billing_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  cache_type TEXT NOT NULL,
  billing_cycle TEXT DEFAULT '',
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, cache_type, billing_cycle)
);
