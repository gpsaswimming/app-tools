-- Credential Tracker — D1 schema (database binding: DB)
-- Apply with:
--   wrangler d1 execute gpsa-credentials --remote --file=db/schema.sql
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS cards (
  n       INTEGER PRIMARY KEY,   -- 1..100, the printed card number
  status  TEXT    NOT NULL DEFAULT 'in',   -- in | out | lost
  name    TEXT,                  -- pre-assigned holder (or spare pickup)
  team    TEXT,
  role    TEXT,
  out_at  INTEGER                -- epoch ms when last checked out
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Seed cards 1..100 (only inserts rows that don't already exist).
INSERT OR IGNORE INTO cards (n)
  WITH RECURSIVE seq(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM seq WHERE n < 100
  )
  SELECT n FROM seq;
