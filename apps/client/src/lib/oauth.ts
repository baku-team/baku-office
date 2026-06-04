// 実OAuth（設計書§6.2）。組織=Google／個人=LINE Login・Discord。
// クレデンシャル未設定のプロバイダは無効（UIに出さない＝devログインで代替）。
import { randomId } from "@baku-office/shared";

export type Provider = "google" | "line" | "discord";

type Conf = { id?: string; secret?: string; authUrl: string; tokenUrl: string; scope: string };
function conf(env: Env, p: Provider): Conf {
  switch (p) {
    case "google":
      return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scope: "openid email profile" };
    case "line":
      return { id: env.LINE_LOGIN_CHANNEL_ID, secret: env.LINE_LOGIN_CHANNEL_SECRET, authUrl: "https://access.line.me/oauth2/v2.1/authorize", tokenUrl: "https://api.line.me/oauth2/v2.1/token", scope: "profile openid" };
    case "discord":
      return { id: env.DISCORD_CLIENT_ID, secret: env.DISCORD_CLIENT_SECRET, authUrl: "https://discord.com/oauth2/authorize", tokenUrl: "https://discord.com/api/oauth2/token", scope: "identify" };
  }
}

export function providerEnabled(env: Env, p: Provider): boolean {
  const c = conf(env, p);
  return !!(c.id && c.secret);
}

export function redirectUri(origin: string, p: Provider): string {
  return `${origin}/api/auth/${p}/callback`;
}

// 認可開始URL（state はCSRF対策。呼び出し側が state Cookie をセット）。
export function authorizeUrl(env: Env, p: Provider, origin: string, state: string): string | null {
  const c = conf(env, p);
  if (!c.id || !c.secret) return null;
  const u = new URL(c.authUrl);
  u.searchParams.set("client_id", c.id);
  u.searchParams.set("redirect_uri", redirectUri(origin, p));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", c.scope);
  u.searchParams.set("state", state);
  if (p === "google") u.searchParams.set("access_type", "online");
  return u.toString();
}

// コード交換 → 外部IDとプロフィール取得。
export async function exchange(env: Env, p: Provider, code: string, origin: string): Promise<{ externalId: string; name: string; email?: string } | null> {
  const c = conf(env, p);
  if (!c.id || !c.secret) return null;
  const tr = await fetch(c.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin, p), client_id: c.id, client_secret: c.secret }),
  });
  if (!tr.ok) {
    console.log(`[oauth-${p}-token]`, tr.status, (await tr.text()).slice(0, 200));
    return null;
  }
  const tok = (await tr.json()) as { access_token?: string; id_token?: string };
  if (!tok.access_token) return null;

  if (p === "google") {
    const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) return null;
    const u = (await r.json()) as { sub: string; email?: string; name?: string };
    return { externalId: u.sub, name: u.name ?? u.email ?? "", email: u.email };
  }
  if (p === "line") {
    const r = await fetch("https://api.line.me/v2/profile", { headers: { authorization: `Bearer ${tok.access_token}` } });
    if (!r.ok) return null;
    const u = (await r.json()) as { userId: string; displayName?: string };
    return { externalId: u.userId, name: u.displayName ?? "" };
  }
  // discord
  const r = await fetch("https://discord.com/api/users/@me", { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!r.ok) return null;
  const u = (await r.json()) as { id: string; username?: string };
  return { externalId: u.id, name: u.username ?? "" };
}

export const newState = () => randomId(12);
