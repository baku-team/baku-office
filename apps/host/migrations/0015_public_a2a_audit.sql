-- 招待なし公開中継を from 単位でレート集計するため kind 列を追加（conn / public）。
ALTER TABLE a2a_audit ADD COLUMN kind TEXT NOT NULL DEFAULT 'conn';
