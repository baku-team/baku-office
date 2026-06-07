-- アプリ・レジストリ（中枢管理）：どのアプリが存在するか（各リポで作成→ホストに登録）。
CREATE TABLE IF NOT EXISTS registry_apps (
  id TEXT PRIMARY KEY,            -- アプリID（Part.id）
  name TEXT NOT NULL,
  version TEXT NOT NULL,          -- 公開中の最新版
  repo_url TEXT,                  -- 各アプリのリポジトリ
  publisher TEXT,                 -- 公開者
  category TEXT,
  permissions TEXT,              -- 要求権限（JSON配列）
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / blocked
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 利用状況：どのクライアント（ライセンス）が、どのアプリを、どの版で使っているか。
-- クライアントが統合チェック（/api/check）の際に導入アプリ一覧（id:version・PIIなし）を申告して更新。
CREATE TABLE IF NOT EXISTS app_usage (
  license_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  version TEXT,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (license_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_app_usage_app ON app_usage (app_id);
