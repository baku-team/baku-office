-- 組織共有スコープを追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE knowledge ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE knowledge ADD COLUMN source_note_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes (scope);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge (scope);
