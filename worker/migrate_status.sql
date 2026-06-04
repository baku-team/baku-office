-- ファイル取り込み状態（uploading/done/error）列を追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
