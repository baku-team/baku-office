// アプリ・レジストリ中枢（ホスト側）：存在するアプリの管理＋利用状況の集計。
import { nowSec } from "./host.ts";

export type RegistryApp = {
  id: string; name: string; version: string; repo_url: string | null; publisher: string | null;
  category: string | null; permissions: string | null; description: string | null; status: string;
  created_at: number; updated_at: number;
};

export async function listApps(env: Env): Promise<RegistryApp[]> {
  return (await env.DB.prepare("SELECT * FROM registry_apps ORDER BY updated_at DESC").all<RegistryApp>()).results;
}

// アプリ登録／更新（各リポの公開時にホストへ登録）。id で upsert。
export async function registerApp(env: Env, a: { id: string; name: string; version: string; repoUrl?: string; publisher?: string; category?: string; permissions?: string[]; description?: string }): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO registry_apps (id,name,version,repo_url,publisher,category,permissions,description,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, repo_url=excluded.repo_url,
       publisher=excluded.publisher, category=excluded.category, permissions=excluded.permissions,
       description=excluded.description, updated_at=excluded.updated_at`,
  ).bind(a.id, a.name, a.version, a.repoUrl ?? null, a.publisher ?? null, a.category ?? null, JSON.stringify(a.permissions ?? []), a.description ?? null, now, now).run();
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
