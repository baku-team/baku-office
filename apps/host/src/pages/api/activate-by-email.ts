import type { APIRoute } from "astro";
import { issueLicenseToken, nowSec, signingJwk, isSafeDeployUrl } from "../../lib/host.ts";
import { importVerifyKey, verifyEnvelope, payloadOf, deleteRepo } from "@baku-office/shared";
import type { Entitlement } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Googleログインによるアクティベート（§4）：クライアントが中継してきた「ホスト自身が署名した relay エンベロープ」
// （/api/relay/google/callback で {sub,email,name,exp} を Ed25519 署名）のみを信頼する。
// WHY: 以前は生の email を信頼していたため、申込メールを知る第三者が POST だけで署名トークンを取得し
// 被害者の deploy_url/last_seen を上書きできた。ホスト署名の検証で「実際のGoogleログイン経由」を必須化する。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { relay?: string; deployUrl?: string };
  if (!b.relay) return json({ error: "認証情報（relay）が必要" }, 401);

  let email = "";
  try {
    const envlp = JSON.parse(atob(b.relay)) as { body: string; sig: string };
    const pub = await importVerifyKey(signingJwk(env)); // 自分の署名鍵の公開部で検証
    if (!(await verifyEnvelope(pub, envlp))) return json({ error: "署名検証に失敗" }, 401);
    const p = payloadOf(envlp) as { email?: string; exp?: number };
    if (!p.exp || p.exp < nowSec()) return json({ error: "認証情報の有効期限切れ" }, 401);
    email = (p.email ?? "").trim().toLowerCase();
  } catch {
    return json({ error: "認証情報が不正" }, 401);
  }
  if (!email) return json({ error: "メールアドレスを取得できません" }, 400);

  const lic = await env.DB.prepare(
    "SELECT l.license_id AS id, l.entitlement AS ent FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE lower(c.contact_email) = ? AND l.status = 'active' ORDER BY l.created_at DESC LIMIT 1",
  ).bind(email).first<{ id: string; ent: string }>();
  if (!lic) return json({ error: "このGoogleアカウント（メール）に対応する申込が見つかりません" }, 404);

  if (b.deployUrl && isSafeDeployUrl(b.deployUrl)) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ?").bind(b.deployUrl, nowSec(), lic.id).run();
    // deploy 完了＝公開 throwaway リポ（app-<licenseId>・report.json に deploy_code 平文）は役目終了。
    // 即削除して公開露出を最小化（private 化は他者CFが Deploy で clone 不可になるため採らない）。
    if (env.GITHUB_TOKEN && env.GITHUB_OWNER) {
      try { await deleteRepo({ token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER }, lic.id); } catch { /* best-effort */ }
    }
  }
  const token = await issueLicenseToken(env, lic.id, lic.ent as Entitlement);
  return json({ ok: true, token, licenseId: lic.id });
};
