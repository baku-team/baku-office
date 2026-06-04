-- 既存DB（name列なし）に書類のファイル名列を追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN name TEXT;
