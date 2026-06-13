-- 運用クォータの自己カウント（KV書き込み等）。CFは実行時にKV書込回数を出さないため自前で日次集計する。
-- api_usage（AI/API回数）とは別テーブル＝AI使用量の集計を汚さない。op=種別（例 kv_write）、day=UTC日付。
CREATE TABLE IF NOT EXISTS op_usage (
  op    TEXT NOT NULL,
  day   TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (op, day)
);
