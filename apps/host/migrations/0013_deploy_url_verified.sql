-- §4-3：deploy-report のオンボーディングDoS対策。
-- deploy_url の確定経路を「仮登録（unauth な /api/deploy-report）」と「確定（Googleログイン突合 /api/activate-by-email）」に分離する。
-- verified=1 は Google 認証で確定済み＝以後の unauth な deploy-report では上書きさせない。
ALTER TABLE licenses ADD COLUMN deploy_url_verified INTEGER NOT NULL DEFAULT 0;
