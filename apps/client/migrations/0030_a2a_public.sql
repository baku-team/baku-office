-- 招待なし公開A2A：受付箱（問い合わせ/接続申請）とブロック名簿。
-- 受付ポリシー（box/auto/hybrid＋信頼閾値）は KV settings(reception_policy) に格納。
-- 公開アクションは a2a_actions.scope='public'（DDL変更不要・値追加のみ）。
CREATE TABLE IF NOT EXISTS a2a_inquiries (
  id           TEXT PRIMARY KEY,
  from_license TEXT NOT NULL,        -- 送信元（ホスト署名で実在保証済み）
  from_name    TEXT,
  action       TEXT,                 -- 要求された公開アクション名（接続申請は 'connect'）
  args         TEXT,                 -- JSON
  message      TEXT,
  trust        TEXT,                 -- JSON: {hostTrust} 受信時に同梱された相手評価
  status       TEXT NOT NULL DEFAULT 'pending', -- pending/approved/rejected/blocked
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inq_status ON a2a_inquiries (status, created_at);

CREATE TABLE IF NOT EXISTS a2a_blocks (
  from_license TEXT PRIMARY KEY,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
