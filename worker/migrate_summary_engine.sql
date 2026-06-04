-- 要約ジョブにエンジン列を追加（gemini=無料 / claude=学習なし）。一度だけ実行。
ALTER TABLE summary_jobs ADD COLUMN engine TEXT NOT NULL DEFAULT 'gemini';
