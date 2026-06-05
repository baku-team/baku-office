-- 会員管理（会費を払う団体会員）。組織メンバー(users)・名簿(knowledge)とは別概念。
CREATE TABLE IF NOT EXISTS membership (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,                          -- 連絡先（電話/メール等）
  fee_status TEXT NOT NULL DEFAULT 'unpaid', -- paid / unpaid / exempt / withdrawn
  paid_at TEXT,                          -- 支払い日時（ISO/任意文字列）
  status_changed_at INTEGER,             -- ステータス変更日時（epoch秒）
  extra TEXT,                            -- 任意項目（JSON文字列）
  stripe_customer TEXT,                  -- Stripe連携（要件B）用の顧客ID（任意）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_membership_name ON membership (name);
CREATE INDEX IF NOT EXISTS idx_membership_fee ON membership (fee_status);
