import { kvPut } from "../../../../lib/kv.ts";
import type { APIRoute } from "astro";
import { exchange, type Provider } from "../../../../lib/oauth.ts";
import { makeSessionCookie, sessionExp, signPending } from "../../../../lib/auth.ts";
import type { Role } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const redir = (loc: string, cookie?: string) =>
  new Response(null, { status: 302, headers: cookie ? { location: loc, "set-cookie": cookie } : { location: loc } });

// OAuthコールバック：state検証 → コード交換 →（組織=Google管理者 / 個人=LINE/Discord）セッション確立。
export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const p = params.provider as Provider;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = /oauth_state=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!code || !state || state !== cookieState) return redir("/login?e=state");

  const prof = await exchange(env, p, code, url.origin);
  if (!prof) return redir("/login?e=oauth");

  if (p === "google") {
    // 組織コンテキスト：設定時の組織Googleアカウント＝最上位管理者（§6.2）。初回ログインで束縛、以後は一致必須。
    const stored = await env.LICENSE.get("org_google_sub");
    if (!stored) await kvPut(env, "org_google_sub", prof.externalId);
    else if (stored !== prof.externalId) return redir("/login?e=notorg");
    const cookie = await makeSessionCookie(env, { uid: "org", role: "admin", ctx: "org", name: prof.name || "組織管理者", exp: sessionExp() });
    return redir("/", cookie);
  }

  // 個人コンテキスト：既存の active な identity ならログイン。未登録は招待参加へ誘導。
  const idn = await env.DB.prepare("SELECT user_id FROM identities WHERE type=? AND external_id=?").bind(p, prof.externalId).first<{ user_id: string }>();
  if (idn) {
    const u = await env.DB.prepare("SELECT id,role,status FROM users WHERE id=?").bind(idn.user_id).first<{ id: string; role: Role; status: string }>();
    if (u?.status === "active") {
      const cookie = await makeSessionCookie(env, { uid: u.id, role: u.role, ctx: "personal", name: prof.name, exp: sessionExp() });
      return redir("/", cookie);
    }
    return redir("/login?e=pending");
  }
  // 未登録 → 招待コードでの参加へ（OAuth identity を署名付き一時Cookieで引き継ぐ＝改竄不可）。
  const pend = await signPending(env, { provider: p, externalId: prof.externalId, name: prof.name });
  return redir("/join", `pending_oauth=${pend}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
};
