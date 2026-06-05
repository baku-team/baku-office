import type { APIRoute } from "astro";
import { makeSessionCookie, sessionExp } from "../../../../lib/auth.ts";
import { getVerifyJwk } from "../../../../lib/client.ts";
import { importVerifyKey, verifyEnvelope, payloadOf } from "@baku-office/shared";

export const prerender = false;
const redir = (loc: string, cookie?: string) =>
  new Response(null, { status: 302, headers: cookie ? { location: loc, "set-cookie": cookie } : { location: loc } });

// ログイン中継の受け口：ホストが署名した {sub,email,name} を VERIFY_PUBLIC_JWK で検証して組織ログイン。
export const GET: APIRoute = async ({ url, request, locals }) => {
  const env = locals.runtime.env;
  const token = url.searchParams.get("relay");
  const state = url.searchParams.get("state");
  const cookieState = /oauth_state=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (url.searchParams.get("e")) return redir("/login?e=oauth");
  if (!token || !state || state !== cookieState) return redir("/login?e=state");
  const jwk = await getVerifyJwk(env);
  if (!jwk) return redir("/login?e=oauth");

  let envlp: { body: string; sig: string };
  try { envlp = JSON.parse(atob(token)); } catch { return redir("/login?e=oauth"); }
  const pub = await importVerifyKey(jwk);
  if (!(await verifyEnvelope(pub, envlp))) return redir("/login?e=oauth");
  const p = payloadOf(envlp) as { sub?: string; email?: string; name?: string; exp?: number };
  if (!p.sub || !p.exp || p.exp < Math.floor(Date.now() / 1000)) return redir("/login?e=state");

  // 組織コンテキスト：初回ログインで組織Googleアカウントを束縛、以後は一致必須（§6.2）。
  const stored = await env.LICENSE.get("org_google_sub");
  if (!stored) await env.LICENSE.put("org_google_sub", p.sub);
  else if (stored !== p.sub) return redir("/login?e=notorg");
  const cookie = await makeSessionCookie(env, { uid: "org", role: "admin", ctx: "org", name: p.name || "組織管理者", exp: sessionExp() });
  return redir("/", cookie);
};
