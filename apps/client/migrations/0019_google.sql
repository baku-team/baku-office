-- Google Meet 会議記録の要約キャッシュ（方式③：会議後トランスクリプト→Claude要約→knowledge/reminders へ反映）。
-- Calendar / Gmail は道具経由のオンデマンド取得で十分なため、ローカルテーブルは持たない（Meet のみキャッシュ）。
CREATE TABLE IF NOT EXISTS meet_records (
  id TEXT PRIMARY KEY,                          -- Meet conferenceRecord 名（conferenceRecords/xxx）
  space_name TEXT,                              -- spaces/xxx
  title TEXT,                                   -- 会議タイトル
  start_time TEXT,                              -- ISO（会議開始）
  end_time TEXT,                                -- ISO（会議終了）
  summary TEXT,                                 -- Claude による議事録要約
  actions TEXT,                                 -- 抽出したアクションアイテム（JSON配列）
  knowledge_saved INTEGER NOT NULL DEFAULT 0,   -- ナレッジ保存済みフラグ（二重保存防止）
  reminders_saved INTEGER NOT NULL DEFAULT 0,   -- リマインダ登録済みフラグ
  owner TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_records_created ON meet_records (created_at);
