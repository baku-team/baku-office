import type { APIRoute } from "astro";
import { googleExchange, isAdminEmail, makeCookie, sessionExp } from "../../../../lib/hostauth.ts";

export const prerender = false;

export const GET: APIRoute = async ({ url, request, locals }) => {
  const env = locals.runtime.env;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = /host_oauth_state=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!code || !state || state !== cookieState) return new Response(null, { status: 302, headers: { location: "/login?e=state" } });

  const prof = await googleExchange(env, code, url.origin);
  if (!prof) return new Response(null, { status: 302, headers: { location: "/login?e=oauth" } });
  const isAdmin = isAdminEmail(env, prof.email);
  const cookie = await makeCookie(env, { email: prof.email, isAdmin, exp: sessionExp() });
  // 管理者は管理ポータルへ、それ以外（申込者）は申込へ。
  return new Response(null, { status: 302, headers: { location: isAdmin ? "/clients" : "/apply", "set-cookie": cookie } });
};
