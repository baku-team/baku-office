-- 既存DBにタスク完了列とリマインダーテーブルを追加。一度だけ実行。
ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  remind_at INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (done, remind_at);
