-- 動画生成は非同期：作成→推定時間後にステータス確認→完了でDL。
CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,          -- line:<userId> 等
  cap_id TEXT NOT NULL,         -- capabilities.id（プロバイダ/キー解決用）
  job_id TEXT,
  status_url TEXT,
  prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / done / error
  file_id TEXT,                 -- 完成動画の files.id
  eta INTEGER NOT NULL,         -- 次に確認する目安時刻(epoch秒)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_videojobs ON video_jobs (status, eta);
