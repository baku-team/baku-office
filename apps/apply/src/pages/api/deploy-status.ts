import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 申込画面のポーリング先（deploy仕様§2.6）：deploy_url が確定したら ready=true で公開URLを返す。
// 申込画面と同一 Worker（apply）で配信するため相対パス /api/deploy-status で到達する。host と同じ D1 を参照。
export const GET: APIRoute = async ({ url, locals }) => {
  const id = (url.searchParams.get("license") ?? "").trim();
  if (!id) return json({ error: "license required" }, 400);
  const row = await env.DB
    .prepare("SELECT deploy_url AS u FROM licenses WHERE license_id = ? LIMIT 1").bind(id).first<{ u: string | null }>();
  return json({ ready: !!row?.u, url: row?.u ?? null });
};
