-- 外部アプリ：レジストリから署名検証して取り込んだアプリ（ランタイム型・データ）。
CREATE TABLE IF NOT EXISTS external_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  category TEXT,
  description TEXT,
  permissions TEXT,      -- JSON配列
  definition TEXT,       -- 宣言的アプリ定義（JSON）
  installed_at INTEGER NOT NULL
);

-- アプリのドラフト：チャットでAI生成→管理者がレビュー→ホストへ公開申請。
CREATE TABLE IF NOT EXISTS app_drafts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '0.1.0',
  category TEXT,
  description TEXT,
  permissions TEXT,      -- JSON配列（要求権限・レビュー対象）
  definition TEXT,       -- 宣言的アプリ定義（JSON）
  status TEXT NOT NULL DEFAULT 'pending', -- pending / submitted / rejected
  created_by TEXT,
  created_at INTEGER NOT NULL
);
