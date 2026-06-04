-- ファイルの遅延参照用 file_id 列を追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN file_id TEXT;
