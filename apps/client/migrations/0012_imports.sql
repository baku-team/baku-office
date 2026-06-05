-- 外部資料インポート（Notion / Googleドライブ）。既定はメタのみ。R2有効時のみ実ファイルを取り込む。
CREATE TABLE IF NOT EXISTS imported_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,      -- drive / notion
  ext_id TEXT,              -- 元のID
  title TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  url TEXT,
  file_id TEXT,             -- R2取り込み時の files.id（メタのみなら NULL）
  imported_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imported_source ON imported_items (source);
