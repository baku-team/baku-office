-- P0-1（IDOR是正）：ファイルにアクセス文脈(ctx)を付与し、所有者/ロール検査の土台にする。
-- org=組織共有プール（org文脈ユーザーが共有）／personal=個人(LINE/Discord等)の私的ファイル。
-- 既存行は歴史的に組織内共有前提だったため 'org' へ backfill（NULL も scoped クエリ側で org 扱い）。
ALTER TABLE files ADD COLUMN ctx TEXT;
UPDATE files SET ctx = 'org' WHERE ctx IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_owner ON files (created_by, deleted_at);
