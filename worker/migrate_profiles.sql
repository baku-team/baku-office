-- 人材ディレクトリ（経歴・スキル・人脈）テーブルを追加。一度だけ実行。
CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles (name);
