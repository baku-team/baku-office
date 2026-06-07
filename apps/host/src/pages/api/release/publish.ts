import type { APIRoute } from "astro";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// リリース公開（CIから呼ぶ）：最新リリース {version, tarballUrl, sig} を PORTAL KV に登録。
// 認証：ヘッダ x-release-key == env.RELEASE_PUBLISH_KEY（CIと共有のsecret）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!env.RELEASE_PUBLISH_KEY || request.headers.get("x-release-key") !== env.RELEASE_PUBLISH_KEY) {
    return json({ error: "forbidden" }, 403);
  }
  const b = (await request.json().catch(() => ({}))) as { version?: string; tarballUrl?: string; sig?: string };
  if (!b.version || !b.tarballUrl || !b.sig) return json({ error: "version・tarballUrl・sig が必要" }, 400);
  if (!/^https:\/\//.test(b.tarballUrl)) return json({ error: "tarballUrl は https" }, 400);
  await env.PORTAL.put("release_latest", JSON.stringify({ version: b.version, tarballUrl: b.tarballUrl, sig: b.sig }));
  return json({ ok: true, version: b.version });
};
