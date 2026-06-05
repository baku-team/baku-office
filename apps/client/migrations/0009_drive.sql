-- Googleドライブ連携：ドライブ内ファイルのメタ情報同期＋バックアップ記録。
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,        -- Drive file id
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  modified TEXT,              -- ISO（modifiedTime）
  parents TEXT,              -- JSON配列文字列
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drive_files_name ON drive_files (name);

-- KV/R2 → Drive バックアップ済みファイルの記録（重複アップロード防止）。
CREATE TABLE IF NOT EXISTS drive_backup_log (
  file_id TEXT PRIMARY KEY,   -- files.id（クライアント側）
  drive_id TEXT,              -- アップロード先 Drive file id
  at INTEGER NOT NULL
);
