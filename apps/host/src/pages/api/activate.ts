import type { APIRoute } from "astro";
import { nowSec, randomId } from "../../lib/host.ts";
import { isDevEnv } from "../../lib/hostauth.ts";

export const prerender = false;

// アクティベーション開始（§4）：クライアントが license 未保持時にここへ誘導される。
// dev（ゼロ入力）経路：?license_id と ?callback を受け、短命コードを発行して callback?code= へ戻す。
// 本番（ENV≠development）は無効＝Googleログイン経由（/api/relay/google→/api/activate-by-email・署名検証）のみ。
// WHY: 本経路は無認証で、licenseId（公開リポ名 app-<id> から判明）だけで被害者ライセンスの
//   コード発行・deploy_url 上書きができてしまうため、本番では塞ぐ（dev 限定）。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  if (!isDevEnv(env)) return new Response("本番は Google ログインで活性化してください", { status: 403 });
  const licenseId = url.searchParams.get("license_id");
  const callback = url.searchParams.get("callback");
  if (!licenseId || !callback) return new Response("license_id と callback が必要", { status: 400 });
  // オープンリダイレクト封鎖：callback は https（または localhost dev）に限定。
  let cb: URL;
  try { cb = new URL(callback); } catch { return new Response("callback が不正", { status: 400 }); }
  if (cb.protocol !== "https:" && cb.hostname !== "localhost" && cb.hostname !== "127.0.0.1") {
    return new Response("callback は https のみ", { status: 400 });
  }

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
