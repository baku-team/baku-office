-- 会計拡張の土台：勘定科目マスタ・複式仕訳・固定資産/減価償却・レジ締め・外部連携の重複防止。
-- 既存の単式（transactions/categories/wallets）は壊さず、勘定科目を後付けする（account_item_id を ALTER）。
-- 既定勘定科目の投入はアプリ層で冪等に行う（DDL限定の規約・ensureChartOfAccounts）。

-- 勘定科目マスタ。major=資産/負債/純資産/収益/費用、normal_balance=借方/貸方。
CREATE TABLE IF NOT EXISTS account_items (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  major TEXT NOT NULL,
  normal_balance TEXT NOT NULL,
  summary_group TEXT,
  freee_account_item_id TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_items_code ON account_items (code);

-- 既存の科目・口座に勘定科目を紐付け（橋渡しで借方/貸方科目を解決）。
ALTER TABLE categories ADD COLUMN account_item_id TEXT;
ALTER TABLE wallets ADD COLUMN account_item_id TEXT;
-- 取引に勘定科目を直付け（経費のAI勘定科目選択用。未設定なら category 経由で解決）。
ALTER TABLE transactions ADD COLUMN account_item_id TEXT;

-- 複式仕訳。単式取引は橋渡しで都度仕訳化するため、ここには手動仕訳・減価償却・レジ締め差異のみ保存。
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  fiscal_period_id TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  source_ref TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_je_period ON journal_entries (fiscal_period_id, date);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries (source, source_ref);
CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  side TEXT NOT NULL,
  account_item_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  memo TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines (entry_id);

-- 固定資産と減価償却。
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  acquired_date TEXT NOT NULL,
  acquisition_cost INTEGER NOT NULL,
  useful_life_years INTEGER NOT NULL,
  method TEXT NOT NULL,
  residual_value INTEGER NOT NULL DEFAULT 0,
  rate REAL,
  asset_account_item_id TEXT,
  expense_account_item_id TEXT,
  fiscal_period_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS depreciation_entries (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  fiscal_period_id TEXT NOT NULL,
  period_label TEXT NOT NULL,
  amount INTEGER NOT NULL,
  journal_entry_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dep_unique ON depreciation_entries (asset_id, period_label);

-- レジ締め（日次/月次/年度末）。想定額 vs 実査額・差異・AI原因推定。
CREATE TABLE IF NOT EXISTS register_closures (
  id TEXT PRIMARY KEY,
  fiscal_period_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  period_label TEXT NOT NULL,
  expected_amount INTEGER NOT NULL,
  counted_amount INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  ai_reason TEXT,
  adjustment_entry_id TEXT,
  closed_by TEXT,
  closed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_closure ON register_closures (wallet_id, kind, period_label);

-- 外部連携（Square/freee）の取込重複防止。今回はDDLのみ（取込コードは後続）。
CREATE TABLE IF NOT EXISTS external_sync (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  local_id TEXT,
  local_kind TEXT,
  imported_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_sync ON external_sync (source, external_id);
