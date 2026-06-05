import type { APIRoute } from "astro";
import { nowSec, buildCheck, signingJwk } from "../../lib/host.ts";
import { openLicense, type Envelope } from "@baku-office/shared";

export const prerender = false;

// 統合チェック（§13.1）：トークン検証 → {entitlement, latestVersion, notices}。
// 検証は署名鍵の公開部分（importVerifyKey が x のみ使用）。最新エンタイトルメントはD1から再取得。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  const token = url.searchParams.get("token");
  const deployUrl = url.searchParams.get("deploy_url");
  const version = url.searchParams.get("version");
  if (!token) return json({ error: "token が必要" }, 400);

  let envlp: Envelope;
  try {
    envlp = JSON.parse(atob(token)) as Envelope;
  } catch {
    return json({ error: "token 形式不正" }, 400);
  }
  const payload = await openLicense(signingJwk(env), envlp, nowSec());
  if (!payload) return json({ error: "token 無効または失効" }, 401);

  // D1 から最新エンタイトルメント（Stripe入金確認で切替＝§2.3）＋ last_seen 更新。
  const lic = await env.DB.prepare("SELECT entitlement FROM licenses WHERE license_id = ?")
    .bind(payload.licenseId)
    .first<{ entitlement: "free" | "plus" | "pro" }>();
  const entitlement = lic?.entitlement ?? payload.entitlement;
  await env.DB.prepare("UPDATE licenses SET last_seen = ?, deploy_url = COALESCE(?, deploy_url), version = COALESCE(?, version) WHERE license_id = ?")
    .bind(nowSec(), deployUrl, version, payload.licenseId)
    .run();

  return json(await buildCheck(env, entitlement));
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
