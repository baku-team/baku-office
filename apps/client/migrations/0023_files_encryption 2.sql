-- ファイル保存時暗号化と保持期限（第三者レビュー P0-5）。
-- enc=1 は本体が MASTER_KEY 由来鍵で AES-GCM 暗号化済み（既存=0 は平文・後方互換）。
-- expires_at（UTC秒）を過ぎたファイルは削除ジョブが物理削除する。
ALTER TABLE files ADD COLUMN enc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_files_expires ON files (expires_at);
