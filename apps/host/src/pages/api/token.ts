import type { APIRoute } from "astro";
import { nowSec, issueLicenseToken } from "../../lib/host.ts";
import type { Entitlement } from "@baku-office/shared";

export const prerender = false;

// コード交換（§4手順4）：アクティベーションコード → 署名済みライセンストークン。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
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
  if (b.deployUrl) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ?")
      .bind(b.deployUrl, now, row.license_id)
      .run();
  }

  const token = await issueLicenseToken(env, row.license_id, lic.entitlement);
  return json({ ok: true, token, entitlement: lic.entitlement, licenseId: row.license_id });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
