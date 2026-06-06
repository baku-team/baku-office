import type { APIRoute } from "astro";
import { nowSec } from "../../lib/host.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 初回デプロイ自動点灯（deploy仕様§2.5）：クライアントの postdeploy.mjs から {code,url} を受領し
// deploy_code → license を引き当てて deploy_url を保存。first-write-wins（偽報告レース緩和）。
// ホストはトークン等を保持しない。受け取るのは公開URLのみ（原則1）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const { code = "", url = "" } = (await request.json().catch(() => ({}))) as { code?: string; url?: string };
  if (!code || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(url)) return json({ error: "bad" }, 400);

  const lic = await env.DB.prepare(
    "SELECT license_id AS id, deploy_url AS u FROM licenses WHERE deploy_code = ? AND status = 'active' LIMIT 1",
  ).bind(code).first<{ id: string; u: string | null }>();
  if (!lic) return json({ error: "unknown" }, 404);

  if (!lic.u) {
    await env.DB.prepare("UPDATE licenses SET deploy_url = ?, last_seen = ? WHERE license_id = ?")
      .bind(url, nowSec(), lic.id).run();
  }
  return json({ ok: true });
};
