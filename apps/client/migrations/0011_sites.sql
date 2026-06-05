-- HP/LP 公開機構（Pro以上）。サブパス公開（/site・/lp/<slug>）。slug=home がトップ。
CREATE TABLE IF NOT EXISTS sites (
  slug TEXT PRIMARY KEY,         -- home / 任意スラッグ
  title TEXT NOT NULL,
  body TEXT,                     -- 本文（HTML。管理者入力＝信頼）
  published INTEGER NOT NULL DEFAULT 0,
  show_join INTEGER NOT NULL DEFAULT 0, -- 会員申込フォームを表示（会員管理と連動）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
