-- アプリ内通知：自動取込(owner="org")など LINE 未紐付けスコープ向けの期日通知等を保持。
-- drain（cron）が積み、UI（ヘッダのベル＋/api/notifications）が表示・既読化する。
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,         -- 通知先スコープ（"org" / "line:<id>" / session uid）
  kind TEXT NOT NULL,          -- 種別（reminder 等）
  body TEXT NOT NULL,          -- 本文
  link TEXT,                   -- 任意の遷移先（例 /invoices）
  read_at INTEGER,             -- 既読時刻（NULL=未読）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_owner ON notifications (owner, read_at, created_at);
