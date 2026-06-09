-- アプリ統制（公開停止・削除のキルスイッチ／標準同梱アプリのホスト側ポリシー／クライアント報告の集積）。

-- アプリ削除の墓標。registry_apps を物理削除しても、ここに app_id が残る限り
-- /api/check の revokedApps で全クライアントへ配信し、導入済みでも撤去させる（利用0で物理削除した後も撤去指示は残す）。
CREATE TABLE IF NOT EXISTS app_revocations (
  app_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'deleted', -- blocked（公開停止・復帰可）/ deleted（削除・墓標）
  reason TEXT,
  created_at INTEGER NOT NULL
);

-- 標準同梱アプリ（コアパーツ）のホスト側ポリシー。未登録のIDは既定=有効。
-- enabled=0 にすると /api/check の disabledBuiltins で配信し、全クライアントで除外（登録/除外の実体）。
CREATE TABLE IF NOT EXISTS builtin_policy (
  app_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- クライアントからの自動エラー報告・不具合/要望リクエスト（自己修復ログの集積元）。
-- 人間/外部サービスに依存せず、ここに集積→任意でGitHubへ同期→Claudeが巡回・修復する。
CREATE TABLE IF NOT EXISTS client_reports (
  id TEXT PRIMARY KEY,
  license_id TEXT,
  kind TEXT NOT NULL,                   -- error（自動）/ request（不具合・要望の手動）
  severity TEXT,                        -- error / warn / info（kind=error 用）
  category TEXT,                        -- limit / ai / storage / other
  title TEXT,
  message TEXT NOT NULL,
  context TEXT,
  app_version TEXT,
  fingerprint TEXT,                     -- 同種エラーの重複集約キー（license+category+title 等）
  count INTEGER NOT NULL DEFAULT 1,     -- 同一 fingerprint の再発回数
  status TEXT NOT NULL DEFAULT 'open',  -- open / triaged / synced / resolved / wontfix
  resolution TEXT,                      -- クライアントへ返す対応メモ（修正済み・対応方針など）
  pr_url TEXT,                          -- 自己修復で作成したPRのURL
  issue_url TEXT,                       -- GitHubへ集積したIssueのURL
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON client_reports (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_reports_fp ON client_reports (fingerprint);
CREATE INDEX IF NOT EXISTS idx_reports_lic ON client_reports (license_id, updated_at);
