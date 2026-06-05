-- ホストポータルD1（設計書§7.3）。業務データ・会員PIIは保持しない。
-- B2B顧客・ライセンス・アクティベーション記録・通知のみ。

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  org_name TEXT NOT NULL,          -- 団体名（B2B・暗号化規律は将来。Phase1は平文）
  contact_name TEXT,
  contact_email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  license_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  plan TEXT NOT NULL,              -- free / plus / pro（申込時の選択）
  entitlement TEXT NOT NULL,       -- free / plus / pro（入金確認で昇格＝§2.3）
  status TEXT NOT NULL DEFAULT 'active', -- active / suspended
  google_sub TEXT,                 -- 申込時Googleアカウントのsub（アクティベーション突合）
  deploy_url TEXT,                 -- クライアントのデプロイ先URL
  version TEXT,                    -- クライアントの稼働バージョン（テレメトリ）
  last_seen INTEGER,               -- 最終受信（統合チェック）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_google ON licenses (google_sub);

-- 短命アクティベーションコード（§4）。
CREATE TABLE IF NOT EXISTS activation_codes (
  code TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ホスト通知（§13.1・PIIなし）。
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  severity TEXT NOT NULL,          -- info / important / critical
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
