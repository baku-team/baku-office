-- アプリストア：掲載フラグ・DL可能な最低プラン・ダウンロード記録・評価/レビュー。
ALTER TABLE registry_apps ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;        -- 提供者がストア掲載をON
ALTER TABLE registry_apps ADD COLUMN min_entitlement TEXT NOT NULL DEFAULT 'free'; -- DL可能な最低プラン

CREATE TABLE IF NOT EXISTS app_downloads (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_downloads_app ON app_downloads (app_id, downloaded_at);

CREATE TABLE IF NOT EXISTS app_reviews (
  app_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  rating INTEGER NOT NULL,        -- 1-5
  body TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, license_id)
);
CREATE INDEX IF NOT EXISTS idx_app_reviews_app ON app_reviews (app_id);
