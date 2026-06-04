-- 大PDFの分割要約ジョブテーブルを追加。一度だけ実行。
CREATE TABLE IF NOT EXISTS summary_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  file_uri TEXT,
  total_pages INTEGER NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 1,
  chunk_size INTEGER NOT NULL DEFAULT 20,
  partial TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON summary_jobs (status, id);
