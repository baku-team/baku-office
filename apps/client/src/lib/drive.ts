// Googleドライブ連携（§将来バックログ）。OAuth同意でリフレッシュトークンを暗号保存し、
// メタ情報をD1へ同期（検索・参照）＋ KV/R2 のファイルを Drive へ定期バックアップ（任意設定）。
import { randomId } from "@baku-office/shared";
import { getApiKey, saveApiKey } from "./client.ts";
import { getFile, listFiles } from "./storage.ts";
import { nowSec } from "./accounting.ts";

// drive.readonly=メタ読取／drive.file=アプリ作成ファイル（バックアップ先）。
const SCOPE = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const REFRESH_KEY = "drive_refresh";

export function driveConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
function redirectUri(origin: string): string {
  return `${origin}/api/drive/callback`;
}
export function driveAuthUrl(env: Env, origin: string, state: string): string | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline"); // リフレッシュトークン取得
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", state);
  return u.toString();
}
export async function exchangeDriveCode(env: Env, origin: string, code: string): Promise<boolean> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return false;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin), client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!r.ok) { console.log("[drive-token]", r.status, (await r.text()).slice(0, 200)); return false; }
  const t = (await r.json()) as { refresh_token?: string };
  if (!t.refresh_token) return false; // prompt=consent で取得される想定
  await saveApiKey(env, REFRESH_KEY, t.refresh_token);
  return true;
}
export async function driveConnected(env: Env): Promise<boolean> {
  return !!(await getApiKey(env, REFRESH_KEY));
}
export async function driveAccessToken(env: Env): Promise<string | null> {
  const refresh = await getApiKey(env, REFRESH_KEY);
  if (!refresh || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET }),
  });
  if (!r.ok) return null;
  return ((await r.json()) as { access_token?: string }).access_token ?? null;
}

// メタ情報同期（最大5ページ＝1000件目安）。
export async function syncDriveMetadata(env: Env): Promise<{ synced: number; error?: string }> {
  const token = await driveAccessToken(env);
  if (!token) return { synced: 0, error: "Google ドライブが未連携です。" };
  let synced = 0;
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://www.googleapis.com/drive/v3/files");
    u.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)");
    u.searchParams.set("pageSize", "200");
    u.searchParams.set("q", "trashed=false");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await fetch(u, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return { synced, error: `Drive ${r.status}` };
    const d = (await r.json()) as { nextPageToken?: string; files?: { id: string; name: string; mimeType?: string; size?: string; modifiedTime?: string; parents?: string[] }[] };
    for (const f of d.files ?? []) {
      await env.DB.prepare(
        "INSERT INTO drive_files (id,name,mime,size,modified,parents,synced_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,mime=excluded.mime,size=excluded.size,modified=excluded.modified,parents=excluded.parents,synced_at=excluded.synced_at",
      ).bind(f.id, f.name, f.mimeType ?? null, f.size ? Number(f.size) : null, f.modifiedTime ?? null, JSON.stringify(f.parents ?? []), nowSec()).run();
      synced++;
    }
    if (!d.nextPageToken) break;
    pageToken = d.nextPageToken;
  }
  return { synced };
}

export type DriveFileRow = { id: string; name: string; mime: string | null; size: number | null; modified: string | null; synced_at: number };
export async function listDriveFiles(env: Env, q = ""): Promise<DriveFileRow[]> {
  if (q) return (await env.DB.prepare("SELECT id,name,mime,size,modified,synced_at FROM drive_files WHERE name LIKE ? ORDER BY modified DESC LIMIT 200").bind("%" + q + "%").all<DriveFileRow>()).results;
  return (await env.DB.prepare("SELECT id,name,mime,size,modified,synced_at FROM drive_files ORDER BY modified DESC LIMIT 200").all<DriveFileRow>()).results;
}

// バックアップ設定（KV・任意）。
export async function getDriveBackup(env: Env): Promise<{ enabled: boolean }> {
  try { return JSON.parse((await env.LICENSE.get("drive_backup")) ?? '{"enabled":false}') as { enabled: boolean }; } catch { return { enabled: false }; }
}
export async function setDriveBackup(env: Env, enabled: boolean): Promise<void> {
  await env.LICENSE.put("drive_backup", JSON.stringify({ enabled: !!enabled }));
}

async function uploadToDrive(token: string, name: string, mime: string, buf: ArrayBuffer): Promise<string | null> {
  const boundary = "bo_" + randomId();
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  const body = new Blob([pre, buf, post], { type: `multipart/related; boundary=${boundary}` });
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
  if (!r.ok) { console.log("[drive-upload]", r.status); return null; }
  return ((await r.json()) as { id?: string }).id ?? null;
}

// KV/R2 のファイルを Drive へバックアップ（未バックアップ分を最大 limit 件）。Cron から呼ぶ。
export async function backupToDrive(env: Env, limit = 5): Promise<{ uploaded: number; error?: string }> {
  const token = await driveAccessToken(env);
  if (!token) return { uploaded: 0, error: "未連携" };
  const files = await listFiles(env);
  const done = new Set((await env.DB.prepare("SELECT file_id FROM drive_backup_log").all<{ file_id: string }>()).results.map((r) => r.file_id));
  let uploaded = 0;
  for (const f of files) {
    if (uploaded >= limit) break;
    if (done.has(f.id)) continue;
    const data = await getFile(env, f.id);
    if (!data) continue;
    const id = await uploadToDrive(token, data.name, data.mime, data.buf);
    if (id) { await env.DB.prepare("INSERT OR IGNORE INTO drive_backup_log (file_id,drive_id,at) VALUES (?,?,?)").bind(f.id, id, nowSec()).run(); uploaded++; }
  }
  return { uploaded };
}
