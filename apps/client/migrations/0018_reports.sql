-- クライアント→ホストへの報告（自動エラー・不具合/要望リクエスト）の送信アウトボックス。
-- オフライン/一時障害でも貯めておき、cron/drain で未送信分をまとめてホストへ送る。
CREATE TABLE IF NOT EXISTS client_report_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT,
  category TEXT,
  title TEXT,
  message TEXT NOT NULL,
  context TEXT,
  fingerprint TEXT,
  sent INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_sent ON client_report_outbox (sent, created_at);

-- ホストからの対応返信（resolved/wontfix）。利用者へ「対応済み」を表示するため保持。
CREATE TABLE IF NOT EXISTS host_report_replies (
  id TEXT PRIMARY KEY,
  kind TEXT,
  title TEXT,
  status TEXT,
  resolution TEXT,
  pr_url TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
