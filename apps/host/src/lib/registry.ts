// アプリ・レジストリ中枢（ホスト側）：存在するアプリの管理＋利用状況の集計＋署名付き配布。
import { nowSec, signingJwk } from "./host.ts";
import { signEnvelope, importSignKey } from "@baku-office/shared";

export type RegistryApp = {
  id: string; name: string; version: string; repo_url: string | null; publisher: string | null;
  category: string | null; permissions: string | null; description: string | null; status: string;
  definition: string | null; submitted_by: string | null;
  created_at: number; updated_at: number;
};

// 標準同梱アプリ（クライアントに常にバンドルされるコアパーツ）。レジストリ配布対象ではないため
// 「未登録で稼働中」の警告には出さない（要確認＝本当に未知のアプリだけに絞る）。
export const BUILTIN_APP_IDS = ["chat", "accounting", "memo", "reminders", "knowledge", "members"];

export async function listApps(env: Env): Promise<RegistryApp[]> {
  return (await env.DB.prepare("SELECT * FROM registry_apps ORDER BY updated_at DESC").all<RegistryApp>()).results;
}

// アプリ登録／更新（各リポの公開時 or クライアントからの申請）。id で upsert。status は pending。
export async function registerApp(env: Env, a: { id: string; name: string; version: string; repoUrl?: string; publisher?: string; category?: string; permissions?: string[]; description?: string; definition?: unknown; submittedBy?: string }): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO registry_apps (id,name,version,repo_url,publisher,category,permissions,description,definition,submitted_by,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, repo_url=excluded.repo_url,
       publisher=excluded.publisher, category=excluded.category, permissions=excluded.permissions,
       description=excluded.description, definition=excluded.definition, submitted_by=excluded.submitted_by, updated_at=excluded.updated_at`,
  ).bind(a.id, a.name, a.version, a.repoUrl ?? null, a.publisher ?? null, a.category ?? null, JSON.stringify(a.permissions ?? []), a.description ?? null, a.definition != null ? JSON.stringify(a.definition) : null, a.submittedBy ?? null, now, now).run();
}

export async function getApp(env: Env, id: string): Promise<RegistryApp | null> {
  return (await env.DB.prepare("SELECT * FROM registry_apps WHERE id=?").bind(id).first<RegistryApp>()) ?? null;
}

// 承認済みアプリを「ホスト署名付きパッケージ」として配布（クライアントが公開鍵で検証して取り込む）。
// 署名対象＝アプリ定義の本体（id/name/version/permissions/definition/exp）。
export async function signAppPackage(env: Env, app: RegistryApp): Promise<string> {
  const payload = {
    id: app.id, name: app.name, version: app.version,
    permissions: JSON.parse(app.permissions || "[]") as string[],
    category: app.category, description: app.description,
    definition: app.definition ? JSON.parse(app.definition) : null,
    exp: nowSec() + 7 * 86400, // 取り込みトークンの鮮度
  };
  const envlp = await signEnvelope(await importSignKey(signingJwk(env)), payload);
  return btoa(JSON.stringify(envlp)); // {body,sig} を base64 化
}

// 公開カタログ（承認済みのみ・取り込み候補）。
export async function approvedCatalog(env: Env): Promise<{ id: string; name: string; version: string; category: string | null; description: string | null; permissions: string[] }[]> {
  const { results } = await env.DB.prepare("SELECT id,name,version,category,description,permissions FROM registry_apps WHERE status='approved' ORDER BY name").all<{ id: string; name: string; version: string; category: string | null; description: string | null; permissions: string }>();
  return results.map((r) => ({ ...r, permissions: JSON.parse(r.permissions || "[]") }));
}

export async function setAppStatus(env: Env, id: string, status: "pending" | "approved" | "blocked"): Promise<void> {
  await env.DB.prepare("UPDATE registry_apps SET status=?, updated_at=? WHERE id=?").bind(status, nowSec(), id).run();
}

// クライアントからの導入アプリ申告を記録（id:version の配列。PIIなし）。
export async function recordUsage(env: Env, licenseId: string, apps: { id: string; version: string }[]): Promise<void> {
  const now = nowSec();
  for (const a of apps.slice(0, 100)) {
    await env.DB.prepare(
      `INSERT INTO app_usage (license_id, app_id, version, last_seen) VALUES (?,?,?,?)
       ON CONFLICT(license_id, app_id) DO UPDATE SET version=excluded.version, last_seen=excluded.last_seen`,
    ).bind(licenseId, a.id, a.version || null, now).run();
  }
}

// アプリ別の利用集計（導入数・版分布・最終受信）。直近 since 秒以内をアクティブとする。
export async function usageByApp(env: Env, activeWithinSec = 30 * 86400): Promise<{ app_id: string; installs: number; active: number; versions: string }[]> {
  const since = nowSec() - activeWithinSec;
  const { results } = await env.DB.prepare(
    `SELECT app_id,
            COUNT(*) AS installs,
            SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active,
            GROUP_CONCAT(DISTINCT version) AS versions
     FROM app_usage GROUP BY app_id ORDER BY installs DESC`,
  ).bind(since).all<{ app_id: string; installs: number; active: number; versions: string }>();
  return results;
}

// 申告文字列 "id:ver,id2:ver2" をパース。
export function parseAppsParam(s: string | null): { id: string; version: string }[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 100).map((x) => {
    const i = x.lastIndexOf(":");
    return i > 0 ? { id: x.slice(0, i), version: x.slice(i + 1) } : { id: x, version: "" };
  }).filter((a) => /^[a-z0-9_-]{1,64}$/i.test(a.id));
}
