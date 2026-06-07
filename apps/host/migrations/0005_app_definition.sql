-- アプリの配布定義（署名付き fetch で配る本体）と提出元（クライアント申請の追跡）。
ALTER TABLE registry_apps ADD COLUMN definition TEXT;     -- 宣言的アプリ定義（JSON。menu/agentTools宣言/skill等）
ALTER TABLE registry_apps ADD COLUMN submitted_by TEXT;   -- 申請元ライセンスID（チャット生成→申請）
