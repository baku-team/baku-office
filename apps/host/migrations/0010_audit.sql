-- ホスト管理操作の監査ログ（誰がいつ何を変更/削除/承認したか追跡）。
CREATE TABLE IF NOT EXISTS host_audit (
  id TEXT PRIMARY KEY,
  actor_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_audit_created ON host_audit (created_at);
