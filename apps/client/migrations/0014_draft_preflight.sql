-- アプリ開発の企画・仕様＋事前4確認（環境/権限/安全/コスト）をドラフトに保持。
ALTER TABLE app_drafts ADD COLUMN spec TEXT;                 -- 企画・仕様
ALTER TABLE app_drafts ADD COLUMN est_tokens INTEGER;       -- 推定消費トークン/実行
ALTER TABLE app_drafts ADD COLUMN preflight TEXT;           -- 事前確認結果（JSON: {ok, checks[]}）
ALTER TABLE app_drafts ADD COLUMN gate_status TEXT NOT NULL DEFAULT 'planning'; -- planning / ready / blocked
