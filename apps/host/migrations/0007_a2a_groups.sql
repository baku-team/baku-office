-- A2A グループ（3団体以上の連携）。1:1 接続(a2a_connections)とは別管理。監査は a2a_audit を流用。
CREATE TABLE IF NOT EXISTS a2a_groups (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_license TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS a2a_group_members (
  group_id TEXT NOT NULL,
  member_license TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active / revoked
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, member_license)
);
CREATE INDEX IF NOT EXISTS idx_a2a_gm_member ON a2a_group_members (member_license);
