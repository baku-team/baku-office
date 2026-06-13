import type { APIRoute } from "astro";
import { makeSessionCookie, clearSessionCookie, sessionExp } from "../../lib/auth.ts";
import { authLocal } from "../../lib/users.ts";
import { logDiag } from "../../lib/diag.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...headers } });

// ログイン総当たり対策（オンライン攻撃用）。PBKDF2 はオフライン耐性であり、試行回数制限は別途必要。
// IP単位とloginId単位の二重で失敗回数を数え、いずれか超過で429。失敗時のみカウント＝正規ログインは詰まらない。
const WINDOW = 900; // 15分（秒）
const LIMIT_IP = 10; // IP単位 10回/15分
const LIMIT_ID = 5; // loginId単位 5回/15分

async function rlCount(env: Env, key: string): Promise<number> {
  return Number((await env.LICENSE.get(`loginrl:${key}`)) ?? "0");
}
async function rlBump(env: Env, key: string): Promise<void> {
  const k = `loginrl:${key}`;
  const cur = Number((await env.LICENSE.get(k)) ?? "0");
  await env.LICENSE.put(k, String(cur + 1), { expirationTtl: WINDOW });
}
async function rlReset(env: Env, key: string): Promise<void> {
  await env.LICENSE.delete(`loginrl:${key}`);
}

// ログイン。mode=org（dev：本番はGoogle OAuth＝P6）／mode=local（個人・id/pass）。
export const POST: APIRoute = async ({ request, locals }) => {
  const b = (await request.json().catch(() => ({}))) as { mode?: string; loginId?: string; password?: string };

  if (b.mode === "org") {
    // dev専用：本番（HOST_BASE_URL 設定＝中継ログイン有効、または VERIFY_PUBLIC_JWK 設定）では無効化して悪用を防ぐ。
    if (env.HOST_BASE_URL || env.VERIFY_PUBLIC_JWK) return json({ error: "本番では Google でログインしてください" }, 403);
    const cookie = await makeSessionCookie(env, { uid: "org", role: "admin", ctx: "org", name: "組織管理者", exp: sessionExp() });
    return json({ ok: true, role: "admin", ctx: "org" }, 200, { "set-cookie": cookie });
  }
  if (b.mode === "local" && b.loginId && b.password) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const idKey = b.loginId.slice(0, 64).toLowerCase();
    if ((await rlCount(env, `ip:${ip}`)) >= LIMIT_IP || (await rlCount(env, `id:${idKey}`)) >= LIMIT_ID) {
      await logDiag(env, "warn", "security", `login rate-limited ip=${ip} id=${idKey}`);
      return json({ error: "試行回数が上限に達しました。しばらく時間をおいて再度お試しください。" }, 429);
    }
    const u = await authLocal(env, b.loginId, b.password);
    if (!u) {
      await rlBump(env, `ip:${ip}`);
      await rlBump(env, `id:${idKey}`);
      return json({ error: "IDまたはパスワードが違うか、未承認です" }, 401);
    }
    await rlReset(env, `id:${idKey}`); // 成功でloginId側はリセット（正規ユーザーを巻き込まない）。IP側はTTLで自然減衰。
    const cookie = await makeSessionCookie(env, { uid: u.id, role: u.role, ctx: "personal", exp: sessionExp() });
    return json({ ok: true, role: u.role, ctx: "personal" }, 200, { "set-cookie": cookie });
  }
  return json({ error: "mode が不正" }, 400);
};

export const DELETE: APIRoute = async () => json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
