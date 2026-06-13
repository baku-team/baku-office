-- 貘公式認証：人と会って事業を確認した団体に手動で付与する「公認」フラグ。
-- 公認エージェント同士のクリーンな通信（スパム/サクラ排除）に使う。
ALTER TABLE public_directory ADD COLUMN certified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public_directory ADD COLUMN certified_at INTEGER;
ALTER TABLE public_directory ADD COLUMN certified_note TEXT;
