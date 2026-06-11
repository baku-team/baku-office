-- パフォーマンス用インデックス（DDL限定）。
-- 当月収支は date の範囲検索（>= 月初 AND < 翌月初）で使うため date 単体インデックスで range scan を効かせる。
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions (date);
-- 承認待ち（個人→組織）：share_scope='org' AND review_status='pending' ORDER BY created_at。
CREATE INDEX IF NOT EXISTS idx_personal_share_review ON personal_items (share_scope, review_status, created_at);
