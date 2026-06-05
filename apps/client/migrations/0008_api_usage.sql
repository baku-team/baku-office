-- API使用量（日次・プロバイダ別カウント）。AI機能・各APIの利用回数を記録（§使用量画面）。
CREATE TABLE IF NOT EXISTS api_usage (
  provider TEXT NOT NULL,   -- gemini / claude / web_search / image_gen / tts / video_gen / custom
  day TEXT NOT NULL,        -- YYYY-MM-DD（UTC）
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);
