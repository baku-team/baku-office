import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const prerender = false;

// オートパイロット用 GitHub OAuth App の公開 client_id を配布（公開・認証不要）。
// クライアントはこれを取得して device flow を開始する＝各団体での設定が不要（ホストに一度設定すれば全体に行き渡る）。
export const GET: APIRoute = async ({ locals }) => {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID ?? "";
  return new Response(JSON.stringify({ clientId }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
};
