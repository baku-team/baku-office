// ストレージ抽象（設計書§11）：R2バインディングがあれば優先、無ければKV標準モード（カード不要）。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

// KV値の物理上限は25MiB。既定は安全側5MB、高度なオプションで1〜25MBに変更可（§11）。
const KV_HARD_MAX_MB = 25;
const KV_DEFAULT_MB = 5;

export function storageMode(env: Env): "r2" | "kv" {
  return env.MEDIA_R2 ? "r2" : "kv";
}

// 標準モードの1ファイル上限(MB)。LICENSE KV の設定値（無ければ既定5、最大25）。
export async function maxUploadMb(env: Env): Promise<number> {
  const v = Number(await env.LICENSE.get("max_upload_mb"));
  if (!Number.isFinite(v) || v <= 0) return KV_DEFAULT_MB;
  return Math.min(KV_HARD_MAX_MB, Math.max(1, Math.round(v)));
}
export async function setMaxUploadMb(env: Env, mb: number): Promise<number> {
  const clamped = Math.min(KV_HARD_MAX_MB, Math.max(1, Math.round(mb)));
  await env.LICENSE.put("max_upload_mb", String(clamped));
  return clamped;
}

export type FileRow = { id: string; name: string; size: number; mime: string | null; ref: string; created_at: number };

// 保存：R2優先／KVフォールバック（上限超過はエラー）。
export async function saveFile(env: Env, file: File, createdBy: string): Promise<{ id: string; mode: string }> {
  const id = randomId();
  const buf = await file.arrayBuffer();
  let ref: string;
  const mode = storageMode(env);
  if (env.MEDIA_R2) {
    const key = `f/${id}`;
    await env.MEDIA_R2.put(key, buf, { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    ref = `r2:${key}`;
  } else {
    const limit = (await maxUploadMb(env)) * 1024 * 1024;
    if (buf.byteLength > limit) throw new Error(`標準モードは1ファイル ${limit / 1024 / 1024}MB まで（高度なオプションで上限変更 or R2有効化）`);
    const key = `f/${id}`;
    await env.MEDIA.put(key, buf, { metadata: { contentType: file.type || "application/octet-stream" } });
    ref = `kv:${key}`;
  }
  await env.DB.prepare("INSERT INTO files (id,name,size,mime,ref,created_by,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id, file.name || "file", buf.byteLength, file.type || null, ref, createdBy, nowSec())
    .run();
  return { id, mode };
}

export async function getFile(env: Env, id: string): Promise<{ buf: ArrayBuffer; mime: string; name: string } | null> {
  const row = await env.DB.prepare("SELECT name,mime,ref FROM files WHERE id=? AND deleted_at IS NULL").bind(id).first<{ name: string; mime: string | null; ref: string }>();
  if (!row) return null;
  if (row.ref.startsWith("r2:") && env.MEDIA_R2) {
    const obj = await env.MEDIA_R2.get(row.ref.slice(3));
    if (!obj) return null;
    return { buf: await obj.arrayBuffer(), mime: row.mime ?? "application/octet-stream", name: row.name };
  }
  const obj = await env.MEDIA.get(row.ref.replace(/^kv:/, ""), { type: "arrayBuffer" });
  if (!obj) return null;
  return { buf: obj, mime: row.mime ?? "application/octet-stream", name: row.name };
}

export async function listFiles(env: Env): Promise<FileRow[]> {
  return (await env.DB.prepare("SELECT id,name,size,mime,ref,created_at FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC").all<FileRow>()).results;
}
export async function softDeleteFile(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE files SET deleted_at=? WHERE id=?").bind(nowSec(), id).run();
}

// 監査ログ（§12）。
export async function audit(env: Env, actor: string, action: string, target: string): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (id,actor,action,target,timestamp) VALUES (?,?,?,?,?)")
    .bind(randomId(), actor, action, target, nowSec())
    .run();
}
