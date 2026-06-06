import type { APIRoute } from "astro";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 申込画面のポーリング先（deploy仕様§2.5）：deploy_url が確定したら ready=true で公開URLを返す。
export const GET: APIRoute = async ({ url, locals }) => {
  const id = (url.searchParams.get("license") ?? "").trim();
  if (!id) return json({ error: "license required" }, 400);
  const row = await locals.runtime.env.DB
    .prepare("SELECT deploy_url AS u FROM licenses WHERE license_id = ? LIMIT 1").bind(id).first<{ u: string | null }>();
  return json({ ready: !!row?.u, url: row?.u ?? null });
};
