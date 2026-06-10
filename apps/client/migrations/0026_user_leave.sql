-- 会員（ログインユーザー）の脱退申請。本人が退会を申請し、管理者が承認して無効化する。
-- 業務データは団体に帰属するため削除しない（アカウントの無効化のみ）。NULL=申請なし。
ALTER TABLE users ADD COLUMN leave_requested_at INTEGER;
