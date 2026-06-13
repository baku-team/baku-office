-- 公開ディレクトリ：本人(license)が掲載し、不特定多数が検索する。本文データは持たずメタのみ。
-- 招待なし公開A2Aの宛先解決・信頼判定・検証バッジ・通報/ブロックの基盤。
CREATE TABLE IF NOT EXISTS public_directory (
  license_id   TEXT PRIMARY KEY,
  org_name     TEXT NOT NULL,
  profile      TEXT NOT NULL DEFAULT '{}',  -- JSON: {summary, tags[], contact, website, public_actions[{name,label,argHint}]}
  embedding    TEXT,                          -- JSON number[]（client Workers AI bge で生成・正規化済み）
  verification TEXT NOT NULL DEFAULT '{}',   -- JSON: {exists, siteMatch, reputation, score, summary, checked_at}
  trust_score  REAL NOT NULL DEFAULT 0,       -- ホスト算出（plan/運用歴/audit拒否率/通報数）
  listed       INTEGER NOT NULL DEFAULT 0,    -- 公開トグル
  blocked      INTEGER NOT NULL DEFAULT 0,    -- ホスト/通報による掲載停止（キルスイッチ）
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pubdir_listed ON public_directory (listed, blocked);

-- 通報（公開団体への苦情）。閾値超で自動 block の判定材料。
CREATE TABLE IF NOT EXISTS directory_reports (
  id               TEXT PRIMARY KEY,
  target_license   TEXT NOT NULL,
  reporter_license TEXT,
  reason           TEXT,
  detail           TEXT,
  status           TEXT NOT NULL DEFAULT 'open', -- open/reviewed/dismissed
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dirrep_target ON directory_reports (target_license);
