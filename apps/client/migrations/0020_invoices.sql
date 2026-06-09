-- 請求書管理：画像/PDFから抽出した請求情報＋支払いステータス。元ファイルは files テーブル（R2/KV）へ保存し file_id で参照。
-- 抽出は Claude マルチモーダル（lib/media-ai.ts extractInvoiceData）。期日接近の未払は reminders へ通知予約。
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,                   -- 登録者/組織スコープ（自動取込は "org"）
  file_id TEXT,                          -- files テーブルの元ファイル参照（PDF/画像）
  vendor TEXT,                           -- 請求元
  amount INTEGER,                        -- 金額（円・整数）
  issued_date TEXT,                      -- 発行日（ISO日付）
  due_date TEXT,                         -- 支払期日（ISO日付）
  status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid / paid / overdue / canceled
  notes TEXT,
  source TEXT,                           -- mail / manual / chat（入力経路）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status, due_date);
CREATE INDEX IF NOT EXISTS idx_invoices_owner ON invoices (owner, created_at);
