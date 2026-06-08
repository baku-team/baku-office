-- A2A 公開アクション（ノーコード宣言型＋アプリアクション参照）を一元管理。read専用・スコープ付き。
CREATE TABLE IF NOT EXISTS a2a_actions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- 公開名（相手が呼ぶ名前）
  kind TEXT NOT NULL,           -- 'app'（Part.actions参照） / 'decl'（ノーコード宣言）
  spec TEXT NOT NULL,           -- JSON: app={appId,action} / decl={type,config}
  scope TEXT NOT NULL DEFAULT 'common', -- common / conn / group
  target TEXT NOT NULL DEFAULT '',       -- conn=相手license / group=groupId / common=空
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_a2a_actions_name ON a2a_actions (name);
