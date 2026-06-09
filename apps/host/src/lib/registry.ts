// アプリ・レジストリ中枢（ホスト側）：存在するアプリの管理＋利用状況の集計＋署名付き配布＋ストア。
import { nowSec, signingJwk } from "./host.ts";
import { signEnvelope, importSignKey, atLeast, openLicense, type Entitlement, type Envelope } from "@baku-office/shared";

// ライセンストークン → {licenseId, 最新entitlement}（store/DL のプラン判定・なりすまし防止）。
export async function callerFromToken(env: Env, token: string | undefined): Promise<{ licenseId: string; entitlement: Entitlement } | null> {
  if (!token) return null;
  let e: Envelope;
  try { e = JSON.parse(atob(token)) as Envelope; } catch { return null; }
  const p = await openLicense(signingJwk(env), e, nowSec());
  if (!p) return null;
  const lic = await env.DB.prepare("SELECT entitlement FROM licenses WHERE license_id=? AND status='active'").bind(p.licenseId).first<{ entitlement: string }>();
  return { licenseId: p.licenseId, entitlement: (lic?.entitlement ?? p.entitlement) as Entitlement };
}

export type RegistryApp = {
  id: string; name: string; version: string; repo_url: string | null; publisher: string | null;
  category: string | null; permissions: string | null; description: string | null; status: string;
  definition: string | null; submitted_by: string | null;
  listed?: number; min_entitlement?: string; // 0008 ストア（掲載/最低プラン）
  created_at: number; updated_at: number;
};

// 標準同梱アプリ（クライアントに常にバンドルされるコアパーツ）。レジストリ配布対象ではないため
// 「未登録で稼働中」の警告には出さない（要確認＝本当に未知のアプリだけに絞る）。
// クライアント parts/index.ts の registerBuiltinParts と一致させる（site/import/branding も同梱）。
export const BUILTIN_APP_IDS = ["chat", "accounting", "memo", "reminders", "knowledge", "members", "site", "import", "branding"];
// 同梱アプリの表示名（標準同梱アプリ管理UI用）。
export const BUILTIN_LABELS: Record<string, string> = {
  chat: "AIチャット", accounting: "会計", memo: "メモ", reminders: "リマインダー",
  knowledge: "ナレッジ", members: "会員", site: "サイト", import: "インポート", branding: "ブランディング",
};
// 除外不可の必須アプリ（クライアント MANDATORY_APPS と一致）。
export const MANDATORY_BUILTINS = ["chat"];

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

// アプリの撤去指示（墓標）。registry に行が無い未登録アプリの停止/削除にも使える。
// kind=blocked（公開停止・復帰可）/ deleted（削除）。/api/check の revokedApps に載り全クライアントへ配信。
export async function revokeApp(env: Env, id: string, kind: "blocked" | "deleted", reason?: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_revocations (app_id,kind,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET kind=excluded.kind, reason=excluded.reason, created_at=excluded.created_at",
  ).bind(id, kind, reason ?? null, nowSec()).run();
}
// 撤去の取り消し（公開停止からの復帰・誤操作の戻し）。
export async function unrevokeApp(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM app_revocations WHERE app_id=?").bind(id).run();
}

// ストアアプリの削除（決定: 墓標＋利用0で完全削除）。
// 常に墓標へ撤去指示を残し、全クライアントから撤去させる。利用申告(app_usage)が0なら registry 行も物理削除、
// 残っていれば status='deleted' にして履歴を保持（後で利用0になった時に物理削除できる）。
export async function deleteApp(env: Env, id: string, reason?: string): Promise<void> {
  await revokeApp(env, id, "deleted", reason);
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_usage WHERE app_id=?").bind(id).first<{ n: number }>();
  if ((used?.n ?? 0) === 0) {
    await env.DB.prepare("DELETE FROM registry_apps WHERE id=?").bind(id).run();
  } else {
    await env.DB.prepare("UPDATE registry_apps SET status='deleted', listed=0, updated_at=? WHERE id=?").bind(nowSec(), id).run();
  }
}

// 全クライアントへ配る撤去アプリ id（公開停止＝blocked＋削除＝deleted、レジストリと墓標を統合）。
export async function revokedAppIds(env: Env): Promise<string[]> {
  const a = await env.DB.prepare("SELECT id FROM registry_apps WHERE status IN ('blocked','deleted')").all<{ id: string }>();
  const b = await env.DB.prepare("SELECT app_id AS id FROM app_revocations").all<{ id: string }>();
  return [...new Set([...a.results.map((r) => r.id), ...b.results.map((r) => r.id)])];
}

// ===== 標準同梱アプリ（コアパーツ）のホスト側ポリシー（登録/除外） =====

// 同梱アプリ別の有効/無効ポリシー（既定=有効）。UI表示用に全 BUILTIN_APP_IDS を網羅して返す。
export async function builtinPolicy(env: Env): Promise<{ id: string; label: string; enabled: boolean; mandatory: boolean }[]> {
  const { results } = await env.DB.prepare("SELECT app_id,enabled FROM builtin_policy").all<{ app_id: string; enabled: number }>();
  const map = new Map(results.map((r) => [r.app_id, r.enabled !== 0]));
  return BUILTIN_APP_IDS.map((id) => ({
    id, label: BUILTIN_LABELS[id] ?? id,
    enabled: map.get(id) ?? true, mandatory: MANDATORY_BUILTINS.includes(id),
  }));
}
// 同梱アプリの登録（enabled=true）/除外（enabled=false）。必須アプリは除外不可。
export async function setBuiltinEnabled(env: Env, id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!BUILTIN_APP_IDS.includes(id)) return { ok: false, error: "未知の同梱アプリです" };
  if (!enabled && MANDATORY_BUILTINS.includes(id)) return { ok: false, error: "必須アプリは除外できません" };
  await env.DB.prepare(
    "INSERT INTO builtin_policy (app_id,enabled,updated_at) VALUES (?,?,?) ON CONFLICT(app_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at",
  ).bind(id, enabled ? 1 : 0, nowSec()).run();
  return { ok: true };
}
// 除外中（enabled=0）の同梱アプリ id（/api/check で配信）。
export async function disabledBuiltinIds(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT app_id FROM builtin_policy WHERE enabled=0").all<{ app_id: string }>();
  return results.map((r) => r.app_id).filter((id) => !MANDATORY_BUILTINS.includes(id));
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

// ===== アプリストア（提供者が任意で公開・プラン別DL・DL数・評価・ランキング/バッジ） =====

export type StoreApp = {
  id: string; name: string; version: string; category: string | null; description: string | null;
  permissions: string[]; min_entitlement: string; downloads: number; avg_rating: number; reviews: number; badges: string[];
};

// ストア掲載（提供者本人＝submitted_by かつ approved のみ）。
export async function setListed(env: Env, appId: string, byLicense: string, listed: boolean, minEntitlement?: string): Promise<{ ok: boolean; error?: string }> {
  const app = await getApp(env, appId);
  if (!app) return { ok: false, error: "アプリが見つかりません" };
  if (app.submitted_by !== byLicense) return { ok: false, error: "提供者のみ公開設定できます" };
  if (app.status !== "approved") return { ok: false, error: "承認済みのアプリのみストアに公開できます" };
  const me = ["free", "plus", "pro", "nonprofit", "enterprise", "test"].includes(String(minEntitlement)) ? String(minEntitlement) : app.min_entitlement;
  await env.DB.prepare("UPDATE registry_apps SET listed=?, min_entitlement=?, updated_at=? WHERE id=?").bind(listed ? 1 : 0, me, nowSec(), appId).run();
  return { ok: true };
}
// ホスト管理者による掲載可否の上書き。
export async function hostSetListed(env: Env, appId: string, listed: boolean, minEntitlement?: string): Promise<void> {
  const me = minEntitlement && ["free", "plus", "pro", "nonprofit", "enterprise", "test"].includes(minEntitlement) ? minEntitlement : undefined;
  await env.DB.prepare("UPDATE registry_apps SET listed=?, min_entitlement=COALESCE(?,min_entitlement), updated_at=? WHERE id=?").bind(listed ? 1 : 0, me ?? null, nowSec(), appId).run();
}

async function statsFor(env: Env, appId: string): Promise<{ downloads: number; avg: number; reviews: number }> {
  const d = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_downloads WHERE app_id=?").bind(appId).first<{ n: number }>();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n, AVG(rating) AS a FROM app_reviews WHERE app_id=?").bind(appId).first<{ n: number; a: number | null }>();
  return { downloads: d?.n ?? 0, avg: r?.a ? Math.round(r.a * 10) / 10 : 0, reviews: r?.n ?? 0 };
}

// ストア・カタログ（掲載中＋承認済み＋プラン充足）。DL数→評価でランキング、バッジ付与。
export async function storeCatalog(env: Env, entitlement: Entitlement): Promise<StoreApp[]> {
  const { results } = await env.DB.prepare("SELECT id,name,version,category,description,permissions,min_entitlement FROM registry_apps WHERE status='approved' AND listed=1").all<{ id: string; name: string; version: string; category: string | null; description: string | null; permissions: string; min_entitlement: string }>();
  const out: StoreApp[] = [];
  for (const a of results) {
    if (!atLeast(entitlement, (a.min_entitlement || "free") as Entitlement)) continue; // プラン未満は出さない
    const s = await statsFor(env, a.id);
    const badges: string[] = [];
    if (s.downloads >= 10) badges.push("人気");
    if (s.avg >= 4.5 && s.reviews >= 3) badges.push("高評価");
    out.push({ id: a.id, name: a.name, version: a.version, category: a.category, description: a.description, permissions: JSON.parse(a.permissions || "[]"), min_entitlement: a.min_entitlement || "free", downloads: s.downloads, avg_rating: s.avg, reviews: s.reviews, badges });
  }
  out.sort((x, y) => y.downloads - x.downloads || y.avg_rating - x.avg_rating);
  return out;
}

// 自分が提供（submitted_by）したアプリ一覧（公開設定UI用・状態/掲載/統計つき）。
export async function myApps(env: Env, licenseId: string): Promise<{ id: string; name: string; version: string; status: string; listed: number; min_entitlement: string; downloads: number; avg: number; reviews: number }[]> {
  const { results } = await env.DB.prepare("SELECT id,name,version,status,listed,min_entitlement FROM registry_apps WHERE submitted_by=? ORDER BY updated_at DESC").bind(licenseId).all<{ id: string; name: string; version: string; status: string; listed: number; min_entitlement: string }>();
  const out = [];
  for (const a of results) { const s = await statsFor(env, a.id); out.push({ ...a, min_entitlement: a.min_entitlement || "free", downloads: s.downloads, avg: s.avg, reviews: s.reviews }); }
  return out;
}

export async function recordDownload(env: Env, appId: string, licenseId: string): Promise<void> {
  // ユニーク導入数として記録（同一ライセンスの再DLは時刻更新のみ＝二重計上しない）。
  await env.DB.prepare("INSERT INTO app_downloads (app_id,license_id,downloaded_at) VALUES (?,?,?) ON CONFLICT(app_id,license_id) DO UPDATE SET downloaded_at=excluded.downloaded_at")
    .bind(appId, licenseId, nowSec()).run();
}
export async function rateApp(env: Env, appId: string, licenseId: string, rating: number, body?: string): Promise<{ ok: boolean; error?: string }> {
  const r = Math.max(1, Math.min(5, Math.round(rating)));
  if (!(await getApp(env, appId))) return { ok: false, error: "アプリが見つかりません" };
  await env.DB.prepare("INSERT INTO app_reviews (app_id,license_id,rating,body,created_at) VALUES (?,?,?,?,?) ON CONFLICT(app_id,license_id) DO UPDATE SET rating=excluded.rating, body=excluded.body, created_at=excluded.created_at")
    .bind(appId, licenseId, r, body ?? null, nowSec()).run();
  return { ok: true };
}
export async function listReviews(env: Env, appId: string): Promise<{ rating: number; body: string | null; created_at: number }[]> {
  return (await env.DB.prepare("SELECT rating,body,created_at FROM app_reviews WHERE app_id=? ORDER BY created_at DESC LIMIT 50").bind(appId).all<{ rating: number; body: string | null; created_at: number }>()).results;
}
// アプリの掲載可否＋DL最低プラン（管理画面表示用）。
export async function appStoreMeta(env: Env): Promise<Record<string, { listed: number; min_entitlement: string; downloads: number; avg: number; reviews: number }>> {
  const { results } = await env.DB.prepare("SELECT id,listed,min_entitlement FROM registry_apps").all<{ id: string; listed: number; min_entitlement: string }>();
  const out: Record<string, { listed: number; min_entitlement: string; downloads: number; avg: number; reviews: number }> = {};
  for (const a of results) { const s = await statsFor(env, a.id); out[a.id] = { listed: a.listed, min_entitlement: a.min_entitlement || "free", downloads: s.downloads, avg: s.avg, reviews: s.reviews }; }
  return out;
}

// 申告文字列 "id:ver,id2:ver2" をパース。
export function parseAppsParam(s: string | null): { id: string; version: string }[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 100).map((x) => {
    const i = x.lastIndexOf(":");
    return i > 0 ? { id: x.slice(0, i), version: x.slice(i + 1) } : { id: x, version: "" };
  }).filter((a) => /^[a-z0-9_-]{1,64}$/i.test(a.id));
}
