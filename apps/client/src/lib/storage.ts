// ストレージ抽象（設計書§11）：R2バインディングがあれば優先、無ければKV標準モード（カード不要）。
import { randomId, encryptBytes, decryptBytes } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";
import { masterKey } from "./client.ts";

// KV値の物理上限は25MiB。既定は安全側5MB、高度なオプションで1〜25MBに変更可（§11）。
const KV_HARD_MAX_MB = 25;
const KV_DEFAULT_MB = 25; // KV値の物理上限と同じ25MBを既定に（高度なオプションで1〜25に調整可）

export function storageMode(env: Env): "r2" | "kv" {
  return env.MEDIA_R2 ? "r2" : "kv";
}

// ファイル保存用KV。専用 MEDIA があれば使い、無ければ LICENSE を流用（配布は自動プロビジョンのKV衝突回避のため単一KV）。
// キーは "f/<id>" prefix のため LICENSE の他キー（apikey:/license_token 等）と衝突しない。
function mediaKv(env: Env): KVNamespace {
  return env.MEDIA ?? env.LICENSE;
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

// 保持期限（日数）。0=無期限。保存時に expires_at を付与し、削除ジョブが過ぎたものを物理削除する（§12・P0-5）。
export async function getRetentionDays(env: Env): Promise<number> {
  const v = Number(await env.LICENSE.get("file_retention_days"));
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
export async function setRetentionDays(env: Env, days: number): Promise<number> {
  const v = Number.isFinite(days) && days > 0 ? Math.round(days) : 0;
  await env.LICENSE.put("file_retention_days", String(v));
  return v;
}

// 保存：R2優先／KVフォールバック（上限超過はエラー）。本体は MASTER_KEY 由来鍵で保存時暗号化（P0-5）。
export async function saveFile(env: Env, file: File, createdBy: string): Promise<{ id: string; mode: string }> {
  const id = randomId();
  const plain = await file.arrayBuffer();
  const size = plain.byteLength; // 表示は平文サイズ
  // 保存時暗号化（domain=files で他用途と鍵分離）。本番でMASTER_KEY未投入なら masterKey() が throw＝保存を止める。
  const buf = await encryptBytes(await masterKey(env), plain, "files");
  let ref: string;
  const mode = storageMode(env);
  if (env.MEDIA_R2) {
    const key = `f/${id}`;
    await env.MEDIA_R2.put(key, buf, { httpMetadata: { contentType: "application/octet-stream" } });
    ref = `r2:${key}`;
  } else {
    const limit = (await maxUploadMb(env)) * 1024 * 1024;
    if (size > limit) throw new Error(`標準モードは1ファイル ${limit / 1024 / 1024}MB まで（高度なオプションで上限変更 or R2有効化）`);
    const key = `f/${id}`;
    await mediaKv(env).put(key, buf, { metadata: { contentType: "application/octet-stream" } });
    ref = `kv:${key}`;
  }
  const days = await getRetentionDays(env);
  const expires = days > 0 ? nowSec() + days * 86400 : null;
  await env.DB.prepare("INSERT INTO files (id,name,size,mime,ref,created_by,created_at,enc,expires_at) VALUES (?,?,?,?,?,?,?,1,?)")
    .bind(id, file.name || "file", size, file.type || null, ref, createdBy, nowSec(), expires)
    .run();
  return { id, mode };
}

// 生バイト列を取得（暗号化フラグに応じて復号）。
async function readBlob(env: Env, ref: string, enc: number): Promise<ArrayBuffer | null> {
  let raw: ArrayBuffer | null = null;
  if (ref.startsWith("r2:") && env.MEDIA_R2) {
    const obj = await env.MEDIA_R2.get(ref.slice(3));
    raw = obj ? await obj.arrayBuffer() : null;
  } else {
    raw = await mediaKv(env).get(ref.replace(/^kv:/, ""), { type: "arrayBuffer" });
  }
  if (!raw) return null;
  return enc ? decryptBytes(await masterKey(env), raw, "files") : raw;
}

export async function getFile(env: Env, id: string): Promise<{ buf: ArrayBuffer; mime: string; name: string } | null> {
  const row = await env.DB.prepare("SELECT name,mime,ref,enc FROM files WHERE id=? AND deleted_at IS NULL").bind(id).first<{ name: string; mime: string | null; ref: string; enc: number }>();
  if (!row) return null;
  const buf = await readBlob(env, row.ref, row.enc);
  if (!buf) return null;
  return { buf, mime: row.mime ?? "application/octet-stream", name: row.name };
}

export async function listFiles(env: Env): Promise<FileRow[]> {
  return (await env.DB.prepare("SELECT id,name,size,mime,ref,created_at FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC").all<FileRow>()).results;
}
export async function softDeleteFile(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE files SET deleted_at=? WHERE id=?").bind(nowSec(), id).run();
}

// 実体（R2/KV）を物理削除。
async function deleteBlob(env: Env, ref: string): Promise<void> {
  if (ref.startsWith("r2:") && env.MEDIA_R2) { await env.MEDIA_R2.delete(ref.slice(3)); return; }
  await mediaKv(env).delete(ref.replace(/^kv:/, ""));
}

// 削除ジョブ（drain から定期実行・P0-5）：
//   1) 保持期限切れ（expires_at < now・未削除）を物理削除＋ソフトデリート印。
//   2) ソフトデリート済みで猶予(graceDays)を過ぎたものの実体を物理削除（行は監査用に残す）。
export async function purgeFiles(env: Env, limit = 50, graceDays = 30): Promise<{ expired: number; purged: number }> {
  const now = nowSec();
  let expired = 0, purged = 0;
  // 1) 保持期限切れ
  const exp = (await env.DB.prepare("SELECT id,ref FROM files WHERE deleted_at IS NULL AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?").bind(now, limit).all<{ id: string; ref: string }>()).results;
  for (const f of exp) {
    await deleteBlob(env, f.ref).catch(() => {});
    await env.DB.prepare("UPDATE files SET deleted_at=? WHERE id=?").bind(now, f.id).run();
    expired++;
  }
  // 2) ソフトデリート猶予超過の実体掃除（ref を空文字にして再掃除を防ぐ）
  const cutoff = now - graceDays * 86400;
  const old = (await env.DB.prepare("SELECT id,ref FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ? AND ref <> '' LIMIT ?").bind(cutoff, limit).all<{ id: string; ref: string }>()).results;
  for (const f of old) {
    await deleteBlob(env, f.ref).catch(() => {});
    await env.DB.prepare("UPDATE files SET ref='' WHERE id=?").bind(f.id).run();
    purged++;
  }
  return { expired, purged };
}

// 監査ログ（§12）。
export async function audit(env: Env, actor: string, action: string, target: string): Promise<void> {
  await env.DB.prepare("INSERT INTO audit_log (id,actor,action,target,timestamp) VALUES (?,?,?,?,?)")
    .bind(randomId(), actor, action, target, nowSec())
    .run();
}
