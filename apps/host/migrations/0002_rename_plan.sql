-- プラン名称変更（X/Y/Z → free/plus/pro）。既存データがある環境の移行用。
-- 新規環境では 0001 が free/plus/pro 値で作成済みのため該当行なし＝無害（冪等）。
UPDATE licenses SET plan = CASE plan WHEN 'X' THEN 'free' WHEN 'Y' THEN 'plus' WHEN 'Z' THEN 'pro' ELSE plan END;
UPDATE licenses SET entitlement = CASE entitlement WHEN 'Y' THEN 'plus' WHEN 'Z' THEN 'pro' ELSE entitlement END;
