-- 予定とGoogleカレンダーの双方向同期用。
-- google_event_id: 対応する Google カレンダーのイベントID（内部行とGoogle側を1:1で対応付け、
--   取り込み時の重複防止・更新/削除の伝播に使う）。
-- google_synced_at: 最後にGoogleと同期した時刻（取込/プッシュの目安）。
ALTER TABLE schedules ADD COLUMN google_event_id TEXT;
ALTER TABLE schedules ADD COLUMN google_synced_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_sched_gid ON schedules (google_event_id);
