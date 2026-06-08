-- マルチエージェントの長時間ジョブ（バックグラウンド実行）。drain で順次処理。
CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  session_id TEXT,
  prompt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs (status, created_at);
