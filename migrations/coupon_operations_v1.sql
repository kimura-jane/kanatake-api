-- Apply only after production approval and read-only schema verification.
CREATE TABLE IF NOT EXISTS coupon_operations_v1 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  coupon_generation INTEGER NOT NULL,
  attempt_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (device_id, operation, request_id)
);
