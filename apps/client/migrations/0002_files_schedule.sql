-- P4：ファイル・予定。議事録/ナレッジは knowledge を流用（tags で区別）。

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- ファイル名（PIIを入れない運用・§10.2）
  size INTEGER NOT NULL,
  mime TEXT,
  ref TEXT NOT NULL,             -- r2:<key> / kv:<key>
  created_by TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER             -- ソフトデリート（§12）
);
CREATE INDEX IF NOT EXISTS idx_files_live ON files (deleted_at, created_at);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,        -- ISO日時
  end_at TEXT,
  body TEXT,                     -- 詳細（△暗号化推奨だがPhase1は平文）
  created_by TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sched_live ON schedules (deleted_at, start_at);

-- 議事録/ナレッジ用に knowledge へソフトデリート列を追加（既存テーブル）。
ALTER TABLE knowledge ADD COLUMN deleted_at INTEGER;
