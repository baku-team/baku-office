-- 文書のメタ情報（分類・日付・金額）列を追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN category TEXT;
ALTER TABLE notes ADD COLUMN doc_date TEXT;
ALTER TABLE notes ADD COLUMN amount INTEGER;
CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes (user_id, category, doc_date);
