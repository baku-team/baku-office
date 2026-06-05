import type { APIRoute } from "astro";
import { authorizeUrl, providerEnabled, newState, type Provider } from "../../../../lib/oauth.ts";

export const prerender = false;

// OAuth開始：state Cookie を発行して各プロバイダの認可画面へ。
export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = locals.runtime.env;
  const p = params.provider as Provider;
  if (!["google", "line", "discord"].includes(p)) return new Response("不明なプロバイダ", { status: 404 });

  const cookie = (state: string) => `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

  // 自前のGoogle設定がある場合は従来フロー。
  if (providerEnabled(env, p)) {
    const state = newState();
    const target = authorizeUrl(env, p, url.origin, state);
    if (!target) return new Response("設定不足", { status: 500 });
    return new Response(null, { status: 302, headers: { location: target, "set-cookie": cookie(state) } });
  }

  // Google 未設定でも、当社ホストの共有OAuth（中継ログイン）が使えるなら中継へ（クライアントはGoogle設定不要）。
  if (p === "google" && env.HOST_BASE_URL) {
    const state = newState();
    const ret = `${url.origin}/api/auth/google/relay`;
    const relay = `${env.HOST_BASE_URL.replace(/\/$/, "")}/api/relay/google/start?return=${encodeURIComponent(ret)}&cstate=${state}`;
    return new Response(null, { status: 302, headers: { location: relay, "set-cookie": cookie(state) } });
  }
  return new Response("このログイン方法は未設定です", { status: 404 });
};
