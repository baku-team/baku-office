import type { APIRoute } from "astro";
import { authorizeUrl, providerEnabled, newState, type Provider } from "../../../../lib/oauth.ts";

export const prerender = false;

// OAuth開始：state Cookie を発行して各プロバイダの認可画面へ。
export const GET: APIRoute = async ({ params, url, locals }) => {
  const env = locals.runtime.env;
  const p = params.provider as Provider;
  if (!["google", "line", "discord"].includes(p) || !providerEnabled(env, p)) {
    return new Response("このログイン方法は未設定です", { status: 404 });
  }
  const state = newState();
  const target = authorizeUrl(env, p, url.origin, state);
  if (!target) return new Response("設定不足", { status: 500 });
  return new Response(null, {
    status: 302,
    headers: { location: target, "set-cookie": `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
  });
};
