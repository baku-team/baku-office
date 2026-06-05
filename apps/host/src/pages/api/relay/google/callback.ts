import type { APIRoute } from "astro";
import { signEnvelope, importSignKey } from "@baku-office/shared";
import { signingJwk, nowSec } from "../../../../lib/host.ts";

export const prerender = false;
const redir = (loc: string) => new Response(null, { status: 302, headers: { location: loc } });

// ログイン中継のコールバック：当社の Google OAuth で認証し、{sub,email,name} を Ed25519 署名して
// クライアントの relay 受け口へ戻す。クライアントは公開鍵（VERIFY_PUBLIC_JWK）で検証してログインする。
export const GET: APIRoute = async ({ url, locals }) => {
  const env = locals.runtime.env;
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) return new Response("code/state不正", { status: 400 });
  let st: { ret?: string; cstate?: string };
  try { st = JSON.parse(atob(stateRaw)); } catch { return new Response("state不正", { status: 400 }); }
  const ret = st.ret ?? ""; const cstate = st.cstate ?? "";
  let origin: string;
  try { origin = new URL(ret).origin; } catch { return new Response("return不正", { status: 400 }); }
  const ok = await env.DB.prepare("SELECT 1 FROM licenses WHERE deploy_url = ? LIMIT 1").bind(origin).first();
  if (!ok) return new Response("未登録のクライアント", { status: 403 });

  // トークン交換 → userinfo（sub/email/name）。
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${url.origin}/api/relay/google/callback`, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }),
  });
  if (!tr.ok) return redir(`${ret}?e=oauth&state=${encodeURIComponent(cstate)}`);
  const tok = (await tr.json()) as { access_token?: string };
  if (!tok.access_token) return redir(`${ret}?e=oauth&state=${encodeURIComponent(cstate)}`);
  const ur = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!ur.ok) return redir(`${ret}?e=oauth&state=${encodeURIComponent(cstate)}`);
  const u = (await ur.json()) as { sub?: string; email?: string; name?: string };
  if (!u.sub) return redir(`${ret}?e=oauth&state=${encodeURIComponent(cstate)}`);

  const envlp = await signEnvelope(await importSignKey(signingJwk(env)), { sub: u.sub, email: u.email ?? "", name: u.name ?? "", exp: nowSec() + 300 });
  const token = btoa(JSON.stringify(envlp));
  return redir(`${ret}?relay=${encodeURIComponent(token)}&state=${encodeURIComponent(cstate)}`);
};
