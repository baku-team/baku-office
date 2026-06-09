import type { APIRoute } from "astro";
import { nowSec, issueLicenseToken, isSafeDeployUrl } from "../../lib/host.ts";
import { isDevEnv } from "../../lib/hostauth.ts";
import { deleteRepo } from "@baku-office/shared";
import type { Entitlement } from "@baku-office/shared";

export const prerender = false;

// コード交換（§4手順4）：アクティベーションコード → 署名済みライセンストークン。
// dev 経路（/api/activate のコードを交換）。本番は Google relay（activate-by-email）のみ＝ENV で塞ぐ。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!isDevEnv(env)) return json({ error: "本番は Google ログインで活性化してください" }, 403);
  const b = (await request.json().catch(() => ({}))) as { code?: string; deployUrl?: string };
  if (!b.code) return json({ error: "code が必要" }, 400);

  const now = nowSec();
  const row = await env.DB.prepare(
    "SELECT license_id, expires_at, used FROM activation_codes WHERE code = ?",
  )
    .bind(b.code)
    .first<{ license_id: string; expires_at: number; used: number }>();
  if (!row || row.used === 1 || now >= row.expires_at) return json({ error: "コードが無効または期限切れ" }, 400);

  const lic = await env.DB.prepare("SELECT entitlement FROM licenses WHERE license_id = ? AND status = 'active'")
    .bind(row.license_id)
    .first<{ entitlement: Entitlement }>();
  if (!lic) return json({ error: "ライセンス無効" }, 400);

  await env.DB.prepare("UPDATE activation_codes SET used = 1 WHERE code = ?").bind(b.code).run();
  if (b.deployUrl && isSafeDeployUrl(b.deployUrl)) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ?")
      .bind(b.deployUrl, now, row.license_id)
      .run();
    // deploy 完了＝公開 throwaway リポ（app-<licenseId>・report.json に deploy_code 平文）は役目終了。
    // 即削除して公開露出を最小化（リポ private 化は Deploy ボタン＝他者CFが clone 不可になるため採らない）。
    if (env.GITHUB_TOKEN && env.GITHUB_OWNER) {
      try { await deleteRepo({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER }, row.license_id); } catch { /* best-effort */ }
    }
  }

  const token = await issueLicenseToken(env, row.license_id, lic.entitlement);
  return json({ ok: true, token, entitlement: lic.entitlement, licenseId: row.license_id });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
