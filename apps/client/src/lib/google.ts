// Google Workspace 統合連携（Calendar / Gmail / Meet）。OAuth 同意1回で全 scope をまとめて要求し、
// 1つのリフレッシュトークン（apikey:google_refresh）を3パーツで共有する。既存 Drive 連携（apikey:drive_refresh）とは
// 別キーで並存（将来統合）。アクセストークンは毎回リフレッシュ（drive.ts と同方式）。
import { getApiKey, saveApiKey, deleteApiKey } from "./client.ts";

// 書き込み込みの統合 scope。
//   calendar.events            … 予定の閲覧/作成/編集/削除（Meet付き会議の発行）
//   gmail.modify / gmail.send  … メールの閲覧・整理 / 送信
//   meetings.space.created     … 自分が作成した会議スペース・会議記録（トランスクリプト）の取得
//   meetings.space.readonly    … 会議スペースの参照
const SCOPE = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
].join(" ");
const REFRESH_KEY = "google_refresh";

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
function redirectUri(origin: string): string {
  return `${origin}/api/google/callback`;
}
export function googleAuthUrl(env: Env, origin: string, state: string): string | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline"); // リフレッシュトークン取得
  u.searchParams.set("prompt", "consent");      // 既存連携があっても refresh_token を確実に得る
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}
export async function exchangeGoogleCode(env: Env, origin: string, code: string): Promise<boolean> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return false;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!r.ok) { console.log("[google-token]", r.status, (await r.text()).slice(0, 200)); return false; }
  const t = (await r.json()) as { refresh_token?: string };
  if (!t.refresh_token) return false; // prompt=consent で取得される想定
  await saveApiKey(env, REFRESH_KEY, t.refresh_token);
  return true;
}
export async function googleConnected(env: Env): Promise<boolean> {
  return !!(await getApiKey(env, REFRESH_KEY));
}
export async function disconnectGoogle(env: Env): Promise<void> {
  await deleteApiKey(env, REFRESH_KEY);
}
export async function googleAccessToken(env: Env): Promise<string | null> {
  const refresh = await getApiKey(env, REFRESH_KEY);
  if (!refresh || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { access_token?: string }).access_token ?? null;
}

// Google API への共通 fetch（access token を Bearer 付与）。未連携時は null を返す（呼び出し側で未連携扱い）。
export async function googleFetch(env: Env, url: string, init?: RequestInit): Promise<Response | null> {
  const token = await googleAccessToken(env);
  if (!token) return null;
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}
