-- AIチャットのセッションと履歴（セッション切替・モデル選択用）。
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,          -- session.uid 等（個人スコープ）
  title TEXT,
  model TEXT,                   -- gemini / claude / local（既定はエンジン設定）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner ON chat_sessions (owner, updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,           -- user / assistant
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);
