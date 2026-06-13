import type { APIRoute } from "astro";
import { makeCookie, clearCookie, sessionExp, googleEnabled, isDevEnv } from "../../../lib/hostauth.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...h } });

// dev 管理者ログイン（ENV=development かつ Google未設定時のみ有効）。
// WHY: 本番で Google secret 欠落/失効しても、この無認証バックドアが自動で開かないよう ENV で二重に閉じる。
export const POST: APIRoute = async ({ locals }) => {
  if (!isDevEnv(env) || googleEnabled(env)) return json({ error: "本番はGoogleログインを使用" }, 403);
  return json({ ok: true }, 200, { "set-cookie": await makeCookie(env, { email: "dev@admin", isAdmin: true, exp: sessionExp() }) });
};
export const DELETE: APIRoute = async () => json({ ok: true }, 200, { "set-cookie": clearCookie() });
