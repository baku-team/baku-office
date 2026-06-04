-- 高度なオプション：任意API（能力レジストリ §5-2b の api 種別）。BYOK・暗号化保存。
CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,      -- image_gen / tts / video_gen / embed / custom
  provider TEXT,                 -- openai / stability / elevenlabs / 任意
  endpoint TEXT,                 -- カスタム時のURL
  model TEXT,
  api_key TEXT,                  -- AES-GCM暗号化（MASTER_KEY）
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cap_enabled ON capabilities (enabled);

-- 診断・エラーログ（§7.1 診断・サポート／§13.3）。CF制限などの障害をUIに表示する。
CREATE TABLE IF NOT EXISTS diagnostics (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,           -- error / warn / info
  category TEXT NOT NULL,        -- limit（CF制限）/ ai / storage / other
  message TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diag_time ON diagnostics (created_at);
