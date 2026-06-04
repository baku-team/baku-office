-- LINEから登録した情報（メモ＝text／画像＝image／書類＝file）を保存。
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- 'text' | 'image' | 'file'
  content TEXT NOT NULL,     -- textは本文／image・fileはR2キー
  name TEXT,                 -- 書類のファイル名／画像の要約ラベル
  category TEXT,             -- 分類（領収書/請求書/名刺/写真/その他）
  doc_date TEXT,             -- 文書内の日付 YYYY-MM-DD（領収書の発行日など）
  amount INTEGER,            -- 金額（領収書など）
  scope TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'shared'（組織共有）
  file_id TEXT,             -- Anthropic Files API の file_id（質問時に内容参照）
  status TEXT NOT NULL DEFAULT 'done', -- 'uploading' | 'done' | 'error'
  done INTEGER NOT NULL DEFAULT 0, -- タスク完了フラグ
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes (user_id, category, doc_date);
CREATE INDEX IF NOT EXISTS idx_notes_scope ON notes (scope);
CREATE INDEX IF NOT EXISTS idx_notes_user ON notes (user_id, id DESC);

-- 時刻指定のリマインダー（Cronで巡回しPush通知）。
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  remind_at INTEGER NOT NULL,  -- epoch秒
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (done, remind_at);

-- 参照用の長文知識（全文を都度やり取りせず検索でヒット箇所だけ使う）。
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'shared'
  source_note_id INTEGER,                 -- 画像OCRの紐付け（共有連動用）
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge (scope);

-- 人材ディレクトリ（経歴・スキル・人脈）。組織内で横断検索する。
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,      -- スキル・経歴・人脈の本文
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles (name);

-- 会話履歴（KVは書込1千/日が律速 → D1の10万/日へ）。
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,       -- 'user' | 'assistant'
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history (user_id, id DESC);

-- 大PDFの分割要約ジョブ（Cronがページ範囲ごとに少しずつ処理）。
CREATE TABLE IF NOT EXISTS summary_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal',
  file_uri TEXT,                    -- Gemini File API の uri
  total_pages INTEGER NOT NULL DEFAULT 0,
  next_page INTEGER NOT NULL DEFAULT 1,
  chunk_size INTEGER NOT NULL DEFAULT 20,
  partial TEXT NOT NULL DEFAULT '', -- これまでの部分要約
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|error
  engine TEXT NOT NULL DEFAULT 'gemini', -- gemini=無料抽出 / claude=学習なし抽出
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON summary_jobs (status, id);
