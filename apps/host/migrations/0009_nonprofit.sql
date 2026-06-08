-- NonProfit（非営利・全機能無料）申込の審査。承認で licenses.entitlement='nonprofit'。
CREATE TABLE IF NOT EXISTS nonprofit_applications (
  license_id TEXT PRIMARY KEY,
  org_type TEXT,                 -- npo / 教育 / 宗教 / ボランティア 等
  doc_ref TEXT,                  -- 認証番号・書類URL
  description TEXT,              -- 用途・団体説明
  status TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  reason TEXT,                   -- 却下理由
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonprofit_status ON nonprofit_applications (status);
