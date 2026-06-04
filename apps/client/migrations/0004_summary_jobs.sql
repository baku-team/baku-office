-- P6エージェント：大PDF/ファイルの要約ジョブ（Files API＋drainステップ）。
CREATE TABLE IF NOT EXISTS summary_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,           -- line:<userId> 等
  name TEXT,                     -- ファイル名
  file_id TEXT NOT NULL,         -- files.id（KV/R2に保管した本体）
  status TEXT NOT NULL DEFAULT 'pending', -- pending / done / error
  result TEXT,                   -- 要約結果（knowledge にも保存）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sumjobs_status ON summary_jobs (status, created_at);
