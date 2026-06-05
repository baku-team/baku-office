import type { APIRoute } from "astro";
import { googleEnabled } from "../../../../lib/hostauth.ts";
import { randomId } from "@baku-office/shared";

export const prerender = false;

// ログイン中継（共有OAuthアプリ）：当社の1つの Google OAuth でクライアントの組織ログインを代行。
// クライアントは Google 設定不要。return（クライアントの relay 受け口）は登録済みテナント（deploy_url）に限定（オープンリダイレクト防止）。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  if (!googleEnabled(env)) return new Response("Google未設定（中継不可）", { status: 404 });
  const ret = url.searchParams.get("return");
  const cstate = url.searchParams.get("cstate");
  if (!ret || !cstate) return new Response("return と cstate が必要", { status: 400 });
  let origin: string;
  try { origin = new URL(ret).origin; } catch { return new Response("return が不正", { status: 400 }); }
  const ok = await env.DB.prepare("SELECT 1 FROM licenses WHERE deploy_url = ? LIMIT 1").bind(origin).first();
  if (!ok) return new Response("未登録のクライアントです（アクティベーション後にご利用ください）", { status: 403 });

  const state = btoa(JSON.stringify({ ret, cstate, n: randomId(6) }));
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", `${url.origin}/api/relay/google/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: u.toString() } });
};
