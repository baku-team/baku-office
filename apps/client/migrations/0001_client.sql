-- クライアントアプリD1（設計書§8）。配備＝1組織なのでテナント分割なし。
-- 数値・科目・日付・口座区分は平文（集計のため）。PII・摘要はアプリ層で暗号化（§10）。

-- 会計コア（§8.1） --------------------------------------------------------
CREATE TABLE IF NOT EXISTS fiscal_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'      -- open / closed
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                        -- cash / bank
  opening_balance INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- income / expense
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  fiscal_period_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  amount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  fiscal_period_id TEXT NOT NULL,
  date TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- income / expense / transfer
  category_id TEXT,
  amount INTEGER NOT NULL,                    -- 円・整数
  description TEXT,                           -- 摘要（△暗号化推奨）
  counter_wallet_id TEXT,                     -- 振替先
  created_by TEXT,                            -- users.id
  receipt_ref TEXT,                           -- R2参照／個人領収書ID
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                          -- ソフトデリート（§12）
);
CREATE INDEX IF NOT EXISTS idx_tx_period ON transactions (fiscal_period_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_wallet ON transactions (wallet_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions (category_id);

-- マルチユーザー（§8.2） --------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,                          -- 暗号化
  role TEXT NOT NULL DEFAULT 'member',        -- admin / accounting / clerical / other / member
  status TEXT NOT NULL DEFAULT 'invited',     -- invited / pending / active / disabled
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                          -- line / discord / local / google
  external_id TEXT,                            -- LINE userId / Discord id / Google sub
  password_hash TEXT,                          -- local時
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identities_ext ON identities (type, external_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  issued_by TEXT,
  default_role TEXT NOT NULL DEFAULT 'member',
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'        -- active / revoked
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites (code);

CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT,
  file_ref TEXT,
  tags TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,                         -- user.id または 'org'
  action TEXT NOT NULL,
  target TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  type TEXT NOT NULL,                          -- receipt / memo / task / schedule
  title TEXT,
  body TEXT,
  amount INTEGER,
  date TEXT,
  due_at INTEGER,
  status TEXT,
  share_scope TEXT NOT NULL DEFAULT 'personal',-- personal / org
  review_status TEXT NOT NULL DEFAULT 'none',  -- none / pending / approved / rejected
  reviewed_by TEXT,
  reviewed_at INTEGER,
  reject_reason TEXT,
  receipt_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_owner ON personal_items (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_personal_review ON personal_items (review_status);
