import type { APIRoute } from "astro";
import { getApp, signAppPackage } from "../../../lib/registry.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 署名付きアプリ取り込み（公開）。承認済みアプリのみ、ホスト署名パッケージを返す。
// クライアントは VERIFY_PUBLIC_JWK（ホスト公開鍵）で検証してから取り込む。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  const id = (url.searchParams.get("id") ?? "").trim();
  if (!id) return json({ error: "id が必要" }, 400);
  const app = await getApp(env, id);
  if (!app || app.status !== "approved") return json({ error: "承認済みアプリが見つかりません" }, 404);
  return json({ ok: true, pkg: await signAppPackage(env, app) });
};
