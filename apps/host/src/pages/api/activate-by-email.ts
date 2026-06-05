import type { APIRoute } from "astro";
import { issueLicenseToken, nowSec } from "../../lib/host.ts";
import type { Entitlement } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Googleログインによるアクティベート（§4）：ログインした Google のメールと申込メールを突合し、
// 一致すればライセンストークンを発行＋deploy_url を記録（＝当社が団体URLを把握＝初回完了の通知）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { email?: string; deployUrl?: string };
  const email = (b.email ?? "").trim().toLowerCase();
  if (!email) return json({ error: "email が必要" }, 400);

  const lic = await env.DB.prepare(
    "SELECT l.license_id AS id, l.entitlement AS ent FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE lower(c.contact_email) = ? AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 1",
  ).bind(email).first<{ id: string; ent: string }>();
  if (!lic) return json({ error: "このGoogleアカウント（メール）に対応する申込が見つかりません" }, 404);

  if (b.deployUrl) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ?").bind(b.deployUrl, nowSec(), lic.id).run();
  }
  const token = await issueLicenseToken(env, lic.id, lic.ent as Entitlement);
  return json({ ok: true, token, licenseId: lic.id });
};
