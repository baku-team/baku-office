// ストレージ抽象（設計書§11）：R2バインディングがあれば優先、無ければKV標準モード（カード不要）。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

const KV_FALLBACK_LIMIT = 5 * 1024 * 1024; // 標準モード既定5MB（高度オプションで25MiBまで・§11）

export function storageMode(env: Env): "r2" | "kv" {
  return env.MEDIA_R2 ? "r2" : "kv";
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
    if (buf.byteLength > KV_FALLBACK_LIMIT) throw new Error("標準モードは1ファイル5MBまで（高度オプションでR2有効化）");
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
