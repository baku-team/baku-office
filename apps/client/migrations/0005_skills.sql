-- 高度なオプション：ユーザー追加の Agent Skills（SKILL.md駆動）。
-- mode=instruction（通常LLM費）／code（Anthropic code execution＝従量課金・高度なオプション）。
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- 呼び出し名（例：議事録フォーマット, 請求書生成）
  description TEXT,
  skill_md TEXT NOT NULL,        -- SKILL.md（手順・テンプレ）
  mode TEXT NOT NULL DEFAULT 'instruction', -- instruction / code
  enabled INTEGER NOT NULL DEFAULT 0,        -- 管理者がレビューして有効化
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills (enabled);
