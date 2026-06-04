import type { APIRoute } from "astro";
import { makeCookie, clearCookie, sessionExp, googleEnabled } from "../../../lib/hostauth.ts";

export const prerender = false;
const json = (o: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...h } });

// dev 管理者ログイン（Google未設定時のみ有効）。
export const POST: APIRoute = async ({ locals }) => {
  const env = locals.runtime.env;
  if (googleEnabled(env)) return json({ error: "本番はGoogleログインを使用" }, 403);
  return json({ ok: true }, 200, { "set-cookie": await makeCookie(env, { email: "dev@admin", isAdmin: true, exp: sessionExp() }) });
};
export const DELETE: APIRoute = async () => json({ ok: true }, 200, { "set-cookie": clearCookie() });
