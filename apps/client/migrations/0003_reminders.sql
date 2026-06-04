-- P6エージェント：リマインダー（LINEへ通知）。Astro単一Workerはネイティブcron非対応のため、
-- /api/cron/drain（外部スケジューラ or 手動）＋メッセージ受信時の遅延配信で実現。
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,          -- line:<userId> 等
  content TEXT NOT NULL,
  remind_at INTEGER NOT NULL,   -- epoch秒
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (done, remind_at);
