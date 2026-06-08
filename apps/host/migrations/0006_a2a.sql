-- A2A（エージェント間連携）：団体間の接続（相互同意）と監査。ホストがブローカー。
CREATE TABLE IF NOT EXISTS a2a_connections (
  id TEXT PRIMARY KEY,            -- 接続コード（招待コード兼ID）
  org_a_license TEXT NOT NULL,    -- 作成側ライセンス
  org_b_license TEXT,             -- 参加側ライセンス（accept で設定）
  status TEXT NOT NULL DEFAULT 'pending', -- pending / active / revoked
  label_a TEXT,
  label_b TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_conn_a ON a2a_connections (org_a_license);
CREATE INDEX IF NOT EXISTS idx_a2a_conn_b ON a2a_connections (org_b_license);

CREATE TABLE IF NOT EXISTS a2a_audit (
  id TEXT PRIMARY KEY,
  conn_id TEXT,
  from_license TEXT,
  to_license TEXT,
  action TEXT,
  status TEXT,                    -- ok / error / denied
  created_at INTEGER NOT NULL
);
