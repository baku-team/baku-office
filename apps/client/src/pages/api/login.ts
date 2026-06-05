import type { APIRoute } from "astro";
import { makeSessionCookie, clearSessionCookie, sessionExp } from "../../lib/auth.ts";
import { authLocal } from "../../lib/users.ts";

export const prerender = false;
const json = (o: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...headers } });

// ログイン。mode=org（dev：本番はGoogle OAuth＝P6）／mode=local（個人・id/pass）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const b = (await request.json().catch(() => ({}))) as { mode?: string; loginId?: string; password?: string };

  if (b.mode === "org") {
    // dev専用：本番（中継/Google ログインが有効＝VERIFY_PUBLIC_JWK 設定済み）では無効化して悪用を防ぐ。
    if (env.VERIFY_PUBLIC_JWK) return json({ error: "本番では Google でログインしてください" }, 403);
    const cookie = await makeSessionCookie(env, { uid: "org", role: "admin", ctx: "org", name: "組織管理者", exp: sessionExp() });
    return json({ ok: true, role: "admin", ctx: "org" }, 200, { "set-cookie": cookie });
  }
  if (b.mode === "local" && b.loginId && b.password) {
    const u = await authLocal(env, b.loginId, b.password);
    if (!u) return json({ error: "IDまたはパスワードが違うか、未承認です" }, 401);
    const cookie = await makeSessionCookie(env, { uid: u.id, role: u.role, ctx: "personal", exp: sessionExp() });
    return json({ ok: true, role: u.role, ctx: "personal" }, 200, { "set-cookie": cookie });
  }
  return json({ error: "mode が不正" }, 400);
};

export const DELETE: APIRoute = async () => json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
