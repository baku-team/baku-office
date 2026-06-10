import type { APIRoute } from "astro";
import { nowSec } from "../../lib/host.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 初回デプロイ自動点灯（deploy仕様§2.5）：クライアントの postdeploy.mjs から {code,url} を受領し
// deploy_code → license を引き当てて deploy_url を【仮登録】する（§4-3）。
// WHY: deploy_code は公開 throwaway リポの report.json に平文。GitHub をスキャンする攻撃者が正規より先に
//   偽URLを POST するとオンボーディングが詰まり得た。本経路は未認証＝あくまで仮登録とし、Googleログイン突合
//   （/api/activate-by-email・deploy_url_verified=1）を確定の正とする。確定済みは本経路で上書きしない。
// ホストはトークン等を保持しない。受け取るのは公開URLのみ（原則1）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  // IPレート制限：GitHubスキャンによる総当たり的な偽報告を抑止（無料枠KV）。
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rlKey = `deployreportrl:${ip}`;
  const cur = Number((await env.PORTAL.get(rlKey)) ?? "0");
  if (cur >= 20) return json({ error: "too many requests" }, 429);
  await env.PORTAL.put(rlKey, String(cur + 1), { expirationTtl: 3600 });

  const { code = "", url = "" } = (await request.json().catch(() => ({}))) as { code?: string; url?: string };
  if (!code || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(url)) return json({ error: "bad" }, 400);

  const lic = await env.DB.prepare(
    "SELECT license_id AS id, deploy_url AS u, deploy_url_verified AS v FROM licenses WHERE deploy_code = ? AND status = 'active' LIMIT 1",
  ).bind(code).first<{ id: string; u: string | null; v: number }>();
  if (!lic) return json({ error: "unknown" }, 404);

  // 確定済み（Googleログインで verified）には触れない。未確定かつ未設定のときのみ仮登録（first-write-wins）。
  if (!lic.v && !lic.u) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ? AND deploy_url_verified = 0")
      .bind(url, nowSec(), lic.id).run();
  }
  return json({ ok: true });
};
