-- app_downloads を「ユニーク導入数」に是正（同一ライセンスの再DLで二重計上しない）。
-- 旧テーブルは id 主キーで毎回 INSERT＝再DLでランキング/人気バッジが水増しされていた。
-- ⚠️ 非冪等（DROP/RENAME＝データ移行を含む）。**一回限り・適用前にバックアップ必須**。
--    部分適用（DROP 成功・RENAME 失敗）時は手動復旧が必要。本番は適用済み（2026-06-09）。
CREATE TABLE IF NOT EXISTS app_downloads_new (
  app_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  downloaded_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, license_id)
);
INSERT OR IGNORE INTO app_downloads_new (app_id, license_id, downloaded_at)
  SELECT app_id, license_id, MAX(downloaded_at) FROM app_downloads GROUP BY app_id, license_id;
DROP TABLE app_downloads;
ALTER TABLE app_downloads_new RENAME TO app_downloads;
CREATE INDEX IF NOT EXISTS idx_app_downloads_app ON app_downloads (app_id, downloaded_at);
