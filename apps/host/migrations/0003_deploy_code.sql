-- 入力ゼロ初回デプロイ（deploy仕様§2.2）：団体ごとリポに焼く使い捨て nonce。
-- 自動点灯（deploy-report）で deploy_code → license を引き当てる。
ALTER TABLE licenses ADD COLUMN deploy_code TEXT;
CREATE INDEX IF NOT EXISTS idx_licenses_deploy_code ON licenses (deploy_code);
