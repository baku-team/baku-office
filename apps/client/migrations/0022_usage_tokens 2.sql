-- API使用量に token / 推定費用 / 単位 を追加（第三者レビュー P0-2）。
-- 回数(count)だけでは実費とズレるため、provider別の input/output token と推定USDを日次で蓄積する。
-- units = token以外の従量単位（Web検索回数・音声/動画秒数など）。
ALTER TABLE api_usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_usage ADD COLUMN est_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE api_usage ADD COLUMN units INTEGER NOT NULL DEFAULT 0;
