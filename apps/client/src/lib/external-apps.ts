// 外部アプリ：レジストリからの署名検証付き取り込み（ランタイム型）＋ AI生成ドラフト→申請。
import type { Ctx } from "../core/ports.ts";
import { hostFetch, getVerifyJwk, getLicenseId } from "./client.ts";
import { importVerifyKey, verifyEnvelope, payloadOf, randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

type AppPkg = { id: string; name: string; version: string; permissions?: string[]; category?: string | null; description?: string | null; definition?: unknown; exp?: number };

// レジストリから署名付きパッケージを取得し、ホスト公開鍵で検証して取り込む（再デプロイ不要）。
export async function fetchAndInstall(ctx: Ctx, id: string): Promise<{ ok: boolean; error?: string }> {
  const env = ctx.env;
  let r: Response;
  try { r = await hostFetch(env, "/api/registry/fetch?id=" + encodeURIComponent(id)); } catch { return { ok: false, error: "ホストへ接続できません" }; }
  if (!r.ok) return { ok: false, error: "取得に失敗しました（承認済みアプリのみ取得可）" };
  const j = (await r.json().catch(() => ({}))) as { pkg?: string };
  if (!j.pkg) return { ok: false, error: "パッケージがありません" };
  const jwk = await getVerifyJwk(env);
  if (!jwk) return { ok: false, error: "検証鍵を取得できません" };
  let envlp: { body: string; sig: string };
  try { envlp = JSON.parse(atob(j.pkg)); } catch { return { ok: false, error: "パッケージ形式が不正" }; }
  if (!(await verifyEnvelope(await importVerifyKey(jwk), envlp))) return { ok: false, error: "署名検証に失敗（改竄の可能性）" };
  const p = payloadOf(envlp) as AppPkg;
  if (!p.id || !p.exp || p.exp < nowSec()) return { ok: false, error: "パッケージの有効期限切れ" };
  await ctx.db.prepare(
    `INSERT INTO external_apps (id,name,version,category,description,permissions,definition,installed_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,category=excluded.category,
       description=excluded.description,permissions=excluded.permissions,definition=excluded.definition,installed_at=excluded.installed_at`,
  ).bind(p.id, p.name, p.version, p.category ?? null, p.description ?? null, JSON.stringify(p.permissions ?? []), p.definition != null ? JSON.stringify(p.definition) : null, nowSec()).run();
  return { ok: true };
}

export async function listExternalApps(ctx: Ctx): Promise<{ id: string; name: string; version: string; category: string | null; description: string | null; permissions: string[] }[]> {
  const { results } = await ctx.db.prepare("SELECT id,name,version,category,description,permissions FROM external_apps ORDER BY installed_at DESC").all<{ id: string; name: string; version: string; category: string | null; description: string | null; permissions: string }>();
  return results.map((r) => ({ ...r, permissions: JSON.parse(r.permissions || "[]") }));
}
export async function uninstallExternal(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.prepare("DELETE FROM external_apps WHERE id=?").bind(id).run();
}

// ---- AI開発：ドラフト（生成）→レビュー→公開申請 ----
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || ("app-" + randomId(3));

export async function createDraft(ctx: Ctx, d: { name: string; description?: string; permissions?: string[]; definition?: unknown; version?: string }, by?: string): Promise<string> {
  const id = slug(d.name);
  await ctx.db.prepare(
    "INSERT INTO app_drafts (id,name,version,description,permissions,definition,status,created_by,created_at) VALUES (?,?,?,?,?,?, 'pending', ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,version=excluded.version,description=excluded.description,permissions=excluded.permissions,definition=excluded.definition,status='pending'",
  ).bind(id, d.name, d.version ?? "0.1.0", d.description ?? null, JSON.stringify(d.permissions ?? []), d.definition != null ? JSON.stringify(d.definition) : null, by ?? null, nowSec()).run();
  return id;
}
export async function listDrafts(ctx: Ctx): Promise<{ id: string; name: string; version: string; description: string | null; permissions: string[]; status: string }[]> {
  const { results } = await ctx.db.prepare("SELECT id,name,version,description,permissions,status FROM app_drafts ORDER BY created_at DESC").all<{ id: string; name: string; version: string; description: string | null; permissions: string; status: string }>();
  return results.map((r) => ({ ...r, permissions: JSON.parse(r.permissions || "[]") }));
}
export async function deleteDraft(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.prepare("DELETE FROM app_drafts WHERE id=?").bind(id).run();
}

// レビュー後、ホストレジストリへ公開申請（pending 登録・ホスト管理者が承認）。
export async function submitDraft(ctx: Ctx, id: string): Promise<{ ok: boolean; error?: string }> {
  const env = ctx.env;
  const d = await ctx.db.prepare("SELECT * FROM app_drafts WHERE id=?").bind(id).first<{ id: string; name: string; version: string; description: string | null; permissions: string; definition: string | null }>();
  if (!d) return { ok: false, error: "ドラフトが見つかりません" };
  const licenseId = await getLicenseId(env);
  if (!licenseId) return { ok: false, error: "ライセンス未取得" };
  const app = { id: d.id, name: d.name, version: d.version, description: d.description, permissions: JSON.parse(d.permissions || "[]"), definition: d.definition ? JSON.parse(d.definition) : null };
  let r: Response;
  try { r = await hostFetch(env, "/api/registry/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId, app }) }); } catch { return { ok: false, error: "ホストへ接続できません" }; }
  if (!r.ok) { const j = (await r.json().catch(() => ({}))) as { error?: string }; return { ok: false, error: j.error ?? "申請に失敗" }; }
  await ctx.db.prepare("UPDATE app_drafts SET status='submitted' WHERE id=?").bind(id).run();
  return { ok: true };
}
