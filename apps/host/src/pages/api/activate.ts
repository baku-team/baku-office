import type { APIRoute } from "astro";
import { nowSec, randomId } from "../../lib/host.ts";

export const prerender = false;

// アクティベーション開始（§4）：クライアントが license 未保持時にここへ誘導される。
// Phase1（dev）：?license_id と ?callback を受け、短命コードを発行して callback?code= へ戻す。
// 本番：Googleログイン → 申込時 google_sub と突合 → コード発行（このdevではログインを省略）。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  const licenseId = url.searchParams.get("license_id");
  const callback = url.searchParams.get("callback");
  if (!licenseId || !callback) return new Response("license_id と callback が必要", { status: 400 });

  const lic = await env.DB.prepare("SELECT license_id FROM licenses WHERE license_id = ? AND status = 'active'")
    .bind(licenseId)
    .first<{ license_id: string }>();
  if (!lic) return new Response("不明なライセンス", { status: 404 });

  const code = randomId();
  const now = nowSec();
  await env.DB.prepare("INSERT INTO activation_codes (code, license_id, expires_at, used, created_at) VALUES (?,?,?,0,?)")
    .bind(code, licenseId, now + 600, now) // 10分有効
    .run();

  const sep = callback.includes("?") ? "&" : "?";
  return Response.redirect(`${callback}${sep}code=${code}`, 302);
};
