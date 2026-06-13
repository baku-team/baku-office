import { kvPut } from "./kv.ts";
// Google Workspace 連携（Calendar / Gmail / Meet）。用途別に scope を分割し、顧客が必要な権限だけを
// 段階的に同意する（incremental auth）。gmail.readonly / gmail.send は Google の Restricted scope で審査対象のため、
// 既定では付与せず、必要な顧客だけが明示的に有効化できるようにする（第三者レビュー P0-3/P1-1・§6.2）。
// refresh_token（apikey:google_refresh）はクラウンジュエル：失効・最終利用日時・付与scopeを管理する。
import { getApiKey, saveApiKey, deleteApiKey } from "./client.ts";
import { nowSec } from "./accounting.ts";
import { serviceAccountConfigured, serviceAccountAccessToken, clearServiceAccount } from "./google-sa.ts";

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
    // 本アプリの Gmail 操作は一覧/取得/添付取得（読取）のみ＝readonly で足りる。
    // 旧 gmail.modify からスコープを縮小（最小権限・Google審査の軽量化・P1-1）。
    label: "Gmail 閲覧（読み取りのみ）",
    risk: "メール本文・添付・メタデータを読み取れます（変更・削除・送信はしません）。Google の Restricted scope（審査対象）。",
    restricted: true,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
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
// 非Restricted（Google審査不要）グループ。既定付与はこれだけに限定し、Gmail等は明示同意のみ（P1-1）。
const DEFAULT_GROUPS = ALL_GROUPS.filter((g) => !SCOPE_GROUPS[g].restricted);
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

// 不正なグループ指定を除去。空なら「非Restrictedの既定（calendar/meet）」のみ（P1-1）。
// WHY: 以前は空→全グループ＝Gmail(Restricted)まで既定付与だった。最小権限のため、
// Restricted scope（Gmail閲覧/送信）は呼び出し側が明示指定したときだけ要求する。
export function normalizeGroups(groups: string[] | null | undefined): ScopeGroupId[] {
  const valid = (groups ?? []).filter((g): g is ScopeGroupId => g in SCOPE_GROUPS);
  return valid.length ? Array.from(new Set(valid)) : DEFAULT_GROUPS;
}
function scopesFor(groups: ScopeGroupId[]): string {
  return Array.from(new Set(groups.flatMap((g) => SCOPE_GROUPS[g].scopes))).join(" ");
}

// 「Googleが使える状態か」。サービスアカウント(SA)連携済み、または OAuth クライアント資格情報あり。
export async function googleConfigured(env: Env): Promise<boolean> {
  if (await serviceAccountConfigured(env)) return true;
  return !!(await clientId(env)) && !!(await clientSecret(env));
}
// 付与グループからスコープ文字列を作る（SA/OAuth 共通）。空なら非Restrictedの既定。
export async function grantedScopeString(env: Env): Promise<string> {
  const groups = await grantedGroups(env);
  return scopesFor(groups.length ? groups : DEFAULT_GROUPS);
}
// 付与グループ＋連携日時を保存（SA連携の確定時などに使う）。
export async function setGoogleGroups(env: Env, groups: ScopeGroupId[]): Promise<void> {
  await kvPut(env, SCOPES_KEY, JSON.stringify(normalizeGroups(groups)));
  await kvPut(env, CONNECTED_KEY, String(nowSec()));
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

// 実際に付与済みのグループ（保存値）。WHY: 読取は normalizeGroups を通さない。
// normalizeGroups は「要求時の既定補完（空→calendar/meet）」用であり、付与状態の読取に使うと
// 空配列の連携で calendar/meet を付与済みと捏造し、開示/UI表示が実態と乖離する。
async function grantedGroups(env: Env): Promise<ScopeGroupId[]> {
  try {
    const arr = JSON.parse((await env.LICENSE.get(SCOPES_KEY)) ?? "[]");
    return (Array.isArray(arr) ? arr : []).filter((g): g is ScopeGroupId => g in SCOPE_GROUPS);
  } catch { return []; }
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
  await kvPut(env, SCOPES_KEY, JSON.stringify(merged));
  await kvPut(env, CONNECTED_KEY, String(nowSec()));
  return true;
}
export async function googleConnected(env: Env): Promise<boolean> {
  return !!(await getApiKey(env, REFRESH_KEY));
}
// 連携状態（管理画面表示用）：方式(mode)・付与グループ・最終利用・連携日時。
export async function googleStatus(env: Env): Promise<{ connected: boolean; mode: "sa" | "oauth" | null; groups: ScopeGroupId[]; lastUsed: number | null; connectedAt: number | null }> {
  const sa = await serviceAccountConfigured(env);
  const oauth = await googleConnected(env);
  const connected = sa || oauth;
  const num = async (k: string) => { const v = Number(await env.LICENSE.get(k)); return Number.isFinite(v) && v > 0 ? v : null; };
  return { connected, mode: sa ? "sa" : oauth ? "oauth" : null, groups: connected ? await grantedGroups(env) : [], lastUsed: await num(LAST_USED_KEY), connectedAt: await num(CONNECTED_KEY) };
}
// 連携解除：OAuth は refresh_token を失効（revoke）、SA は鍵を破棄。共有の付与情報も削除（P0-3）。
export async function disconnectGoogle(env: Env): Promise<void> {
  const refresh = await getApiKey(env, REFRESH_KEY);
  if (refresh) {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    }).catch(() => {}); // 失効APIが落ちてもローカル削除は続行
  }
  await deleteApiKey(env, REFRESH_KEY);
  await clearServiceAccount(env); // SA鍵・subject・トークンキャッシュも破棄
  await env.LICENSE.delete(SCOPES_KEY);
  await env.LICENSE.delete(LAST_USED_KEY);
  await env.LICENSE.delete(CONNECTED_KEY);
}
export async function googleAccessToken(env: Env): Promise<string | null> {
  // SA連携が設定済みなら SA(DWD) でトークン発行。無ければ OAuth refresh_token。
  if (await serviceAccountConfigured(env)) {
    const token = await serviceAccountAccessToken(env, await grantedScopeString(env));
    if (token) await kvPut(env, LAST_USED_KEY, String(nowSec()));
    return token;
  }
  const refresh = await getApiKey(env, REFRESH_KEY);
  const cid = await clientId(env); const cs = await clientSecret(env);
  if (!refresh || !cid || !cs) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: cid, client_secret: cs }),
  });
  if (!r.ok) return null;
  await kvPut(env, LAST_USED_KEY, String(nowSec())); // 最終利用を記録（クラウンジュエル監視）
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
