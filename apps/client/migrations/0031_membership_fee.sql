-- 名簿に会費金額・ランク（区分）・会計連携用の取引IDを追加。
-- fee_amount: 会費の金額（円）。fee_status が paid になったとき会計へ自動計上する。
-- rank: 会員ランク/区分（正会員・賛助会員 等の自由記述）。
-- fee_tx_id: 自動計上した会計取引のID（二重計上防止＋paid解除時の取り消しに使う）。
ALTER TABLE membership ADD COLUMN fee_amount INTEGER;
ALTER TABLE membership ADD COLUMN rank TEXT;
ALTER TABLE membership ADD COLUMN fee_tx_id TEXT;
