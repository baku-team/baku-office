// Google Workspace 連携（Calendar / Gmail / Meet）。用途別に scope を分割し、顧客が必要な権限だけを
// 段階的に同意する（incremental auth）。gmail.modify / gmail.send は Google の Restricted scope で審査対象のため、
// 必要な顧客だけが有効化できるようにする（第三者レビュー P0-3・§6.2）。
// refresh_token（apikey:google_refresh）はクラウンジュエル：失効・最終利用日時・付与scopeを管理する。
import { getApiKey, saveApiKey, deleteApiKey } from "./client.ts";
import { nowSec } from "./accounting.ts";

// 用途別 scope グループ。UI でリスクを表示し、必要なものだけ同意させる。
export type ScopeGroupId = "calendar" | "gmail_read" | "gmail_send" | "meet";
export const SCOPE_GROUPS: Record<ScopeGroupId, { label: string; risk: string; restricted: boolean; scopes: string[] }> = {
  calendar: {
    label: "カレンダー（予定の閲覧・作成・編集・削除）",
    risk: "予定の作成・削除・編集ができます。",
    restricted: false,
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
  },
  gmail_read: {
    label: "Gmail 閲覧・整理（modify）",
    risk: "メール本文・添付・メタデータを読み取り、ラベル等を変更できます。Google の Restricted scope（審査対象）。",
    restricted: true,
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
  },
  gmail_send: {
    label: "Gmail 送信",
    risk: "あなたのアカウントからメールを送信できます。Google の Restricted scope（審査対象）。",
    restricted: true,
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
  },
  meet: {
    label: "Meet 会議スペース・会議記録",
    risk: "会議スペースの作成・参照、会議記録（トランスクリプト）の取得ができます。",
    restricted: false,
    scopes: ["https://www.googleapis.com/auth/meetings.space.created", "https://www.googleapis.com/auth/meetings.space.readonly"],
  },
};
const ALL_GROUPS = Object.keys(SCOPE_GROUPS) as ScopeGroupId[];
const REFRESH_KEY = "google_refresh";

// OAuth クライアント資格情報の解決：Worker Secret(env)優先、無ければ暗号化KV（管理画面で登録）。
// CFダッシュボード/wrangler を使わず、連携設定UIから client_id/secret を投入できるようにする。
async function clientId(env: Env): Promise<string | null> {
  return env.GOOGLE_CLIENT_ID ?? (await getApiKey(env, "google_client_id"));
}
async function clientSecret(env: Env): Promise<string | null> {
  return env.GOOGLE_CLIENT_SECRET ?? (await getApiKey(env, "google_client_secret"));
}
const SCOPES_KEY = "google_scopes";       // 付与済みグループ（JSON配列）
const LAST_USED_KEY = "google_last_used";  // 最終利用(UTC秒)
const CONNECTED_KEY = "google_connected_at"; // 連携日時(UTC秒)

// 不正なグループ指定を除去。空なら全グループ（後方互換）。
export function normalizeGroups(groups: string[] | null | undefined): ScopeGroupId[] {
  const valid = (groups ?? []).filter((g): g is ScopeGroupId => g in SCOPE_GROUPS);
  return valid.length ? Array.from(new Set(valid)) : ALL_GROUPS;
}
function scopesFor(groups: ScopeGroupId[]): string {
  return Array.from(new Set(groups.flatMap((g) => SCOPE_GROUPS[g].scopes))).join(" ");
}

export async function googleConfigured(env: Env): Promise<boolean> {
  return !!(await clientId(env)) && !!(await clientSecret(env));
}
function redirectUri(origin: string): string {
  return `${origin}/api/google/callback`;
}
// 選択グループのみを要求（incremental auth）。include_granted_scopes で既存付与に積み増し。
export async function googleAuthUrl(env: Env, origin: string, state: string, groups?: ScopeGroupId[]): Promise<string | null> {
  const cid = await clientId(env);
  if (!cid) return null;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", cid);
  u.searchParams.set("redirect_uri", redirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopesFor(normalizeGroups(groups)));
  u.searchParams.set("access_type", "offline"); // リフレッシュトークン取得
  u.searchParams.set("prompt", "consent");      // 既存連携があっても refresh_token を確実に得る
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

async function grantedGroups(env: Env): Promise<ScopeGroupId[]> {
  try { return normalizeGroups(JSON.parse((await env.LICENSE.get(SCOPES_KEY)) ?? "[]")); } catch { return []; }
}
export async function exchangeGoogleCode(env: Env, origin: string, code: string, groups?: ScopeGroupId[]): Promise<boolean> {
  const cid = await clientId(env); const cs = await clientSecret(env);
  if (!cid || !cs) return false;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin), client_id: cid, client_secret: cs }),
  });
  if (!r.ok) { console.log("[google-token]", r.status, (await r.text()).slice(0, 200)); return false; }
  const t = (await r.json()) as { refresh_token?: string };
  if (!t.refresh_token) return false; // prompt=consent で取得される想定
  await saveApiKey(env, REFRESH_KEY, t.refresh_token);
  // 付与グループを積み増し（incremental auth）。連携日時を記録。
  const merged = Array.from(new Set([...(await grantedGroups(env)), ...normalizeGroups(groups)]));
  await env.LICENSE.put(SCOPES_KEY, JSON.stringify(merged));
  await env.LICENSE.put(CONNECTED_KEY, String(nowSec()));
  return true;
}
export async function googleConnected(env: Env): Promise<boolean> {
  return !!(await getApiKey(env, REFRESH_KEY));
}
// 連携状態（管理画面表示用）：付与グループ・最終利用・連携日時。
export async function googleStatus(env: Env): Promise<{ connected: boolean; groups: ScopeGroupId[]; lastUsed: number | null; connectedAt: number | null }> {
  const connected = await googleConnected(env);
  const num = async (k: string) => { const v = Number(await env.LICENSE.get(k)); return Number.isFinite(v) && v > 0 ? v : null; };
  return { connected, groups: connected ? await grantedGroups(env) : [], lastUsed: await num(LAST_USED_KEY), connectedAt: await num(CONNECTED_KEY) };
}
// 連携解除：Google 側で refresh_token を失効（revoke）し、ローカルの鍵・付与情報を削除（P0-3）。
export async function disconnectGoogle(env: Env): Promise<void> {
  const refresh = await getApiKey(env, REFRESH_KEY);
  if (refresh) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => {}); // 失効APIが落ちてもローカル削除は続行
  }
  await deleteApiKey(env, REFRESH_KEY);
  await env.LICENSE.delete(SCOPES_KEY);
  await env.LICENSE.delete(LAST_USED_KEY);
  await env.LICENSE.delete(CONNECTED_KEY);
}
export async function googleAccessToken(env: Env): Promise<string | null> {
  const refresh = await getApiKey(env, REFRESH_KEY);
  const cid = await clientId(env); const cs = await clientSecret(env);
  if (!refresh || !cid || !cs) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: cid, client_secret: cs }),
  });
  if (!r.ok) return null;
  await env.LICENSE.put(LAST_USED_KEY, String(nowSec())); // 最終利用を記録（クラウンジュエル監視）
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
