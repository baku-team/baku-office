-- エージェントの破壊的/対外操作の人間承認キュー（第三者レビュー P0-4）。
-- メール送信・予定改変/削除・A2A連携など「対外/破壊系」ツールは、実行前に preview を出して
-- pending で保留し、人間が承認したときだけ実行する（操作プレビュー→承認→実行）。
CREATE TABLE IF NOT EXISTS agent_approvals (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,            -- 起案スコープ（line:<id> / session uid 等）
  tool TEXT NOT NULL,            -- 対象ツール名
  args TEXT NOT NULL,            -- 引数(JSON)
  preview TEXT NOT NULL,         -- 人間向けの操作プレビュー
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  result TEXT,                  -- 承認実行後の結果
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON agent_approvals (status, created_at);
