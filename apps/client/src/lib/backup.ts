import { kvPut } from "./kv.ts";
// 全データバックアップ／復元（P0-5）。
// D1 全テーブル＋ LICENSE KV（設定・APIキー等）＋ ファイル実体（R2/KV）を 1 つの JSON アーカイブにまとめ、
// ローカルダウンロード／Google ドライブへ出力する。アーカイブ単体で別環境へ復元可能。
// 当社は業務データを預からない構造のため、バックアップは利用団体の自己責任（規約 第7条・consent.ts）。
//
// 暗号化項目（会員PII・APIキー・ファイル）の扱い：
//   decrypt=true（既定）… 復号して出力。別環境（別 MASTER_KEY）へ移行・人手確認できるが、平文の機微情報を含むため取扱注意。
//   decrypt=false（raw）… 暗号化のまま出力。同一 MASTER_KEY 環境への復元向け（鍵も同梱し自己完結）。
import { encryptField, decryptField, encryptBytes, decryptBytes } from "@baku-office/shared";
import { masterKey, APP_VERSION } from "./client.ts";
import { nowSec } from "./accounting.ts";
import { readRawBlob, putRawBlob } from "./storage.ts";
import { applyMigrations } from "./migrate.ts";

const STATE_KEY = "backup_state"; // LICENSE KV：最終バックアップ状態
const SCHED_KEY = "backup_schedule"; // LICENSE KV：定期バックアップ設定
const FILE_PREFIX = "f/"; // ファイル実体の KV キー（files[] で別途扱うため KV ダンプから除外）
const EPHEMERAL_KV = ["loginrl:", "deployreportrl:", "schema_lock"]; // 一時キーは除外
export const BACKUP_STALE_SEC = 7 * 86400; // これを超える未実施でアラート

export type BackupMode = "decrypted" | "raw";
export type BackupState = { lastAt: number; dest: "local" | "drive"; mode: BackupMode; tables: number; files: number };
export type BackupSchedule = { enabled: boolean; mode: BackupMode };

type FileEntry = { id: string; ref: string; dbEnc: number; plain: boolean; name: string; mime: string | null; b64: string };
type Archive = {
  format: "baku-office-backup";
  version: 1;
  createdAt: number;
  appVersion: string;
  schemaVersion: string | null;
  decrypted: boolean;
  d1: Record<string, { rows: Record<string, unknown>[] }>;
  kv: Record<string, string>;
  files: FileEntry[];
};

export async function getBackupState(env: Env): Promise<BackupState | null> {
  try { const s = await env.LICENSE.get(STATE_KEY); return s ? (JSON.parse(s) as BackupState) : null; } catch { return null; }
}
async function setBackupState(env: Env, s: BackupState): Promise<void> {
  await kvPut(env, STATE_KEY, JSON.stringify(s));
}
export async function getBackupSchedule(env: Env): Promise<BackupSchedule> {
  try { return JSON.parse((await env.LICENSE.get(SCHED_KEY)) ?? '{"enabled":false,"mode":"raw"}') as BackupSchedule; } catch { return { enabled: false, mode: "raw" }; }
}
export async function setBackupSchedule(env: Env, s: BackupSchedule): Promise<void> {
  await kvPut(env, SCHED_KEY, JSON.stringify({ enabled: !!s.enabled, mode: s.mode === "decrypted" ? "decrypted" : "raw" }));
}

// 未実施 or 最終実行から7日超過か（ホームのアラート判定）。
export async function backupAlert(env: Env): Promise<{ alert: boolean; never: boolean; lastAt: number | null }> {
  const s = await getBackupState(env);
  if (!s) return { alert: true, never: true, lastAt: null };
  return { alert: nowSec() - s.lastAt > BACKUP_STALE_SEC, never: false, lastAt: s.lastAt };
}

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CH = 0x8000; // 大きなファイルでのスタック溢れ回避（spread の引数上限対策）
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}
function b64ToBuf(s: string): ArrayBuffer {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
}

// 全データのアーカイブを生成。本番で MASTER_KEY 未投入なら masterKey() が throw（暗号化項目を扱うため）。
export async function buildBackup(env: Env, opts: { decrypt: boolean }): Promise<{ json: string; tables: number; files: number }> {
  const key = await masterKey(env);

  // 1) D1 全テーブル（システム表は除外）。
  const tableNames = (await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name",
  ).all<{ name: string }>()).results;
  const d1: Archive["d1"] = {};
  for (const t of tableNames) {
    const rows = (await env.DB.prepare(`SELECT * FROM "${t.name}"`).all()).results as Record<string, unknown>[];
    if (opts.decrypt && t.name === "users") {
      for (const r of rows) {
        if (r.display_name) { try { r.display_name = await decryptField(key, String(r.display_name), "member-pii"); } catch { /* 復号不可はそのまま */ } }
      }
    }
    d1[t.name] = { rows };
  }

  // 2) LICENSE KV（設定・APIキー等）。ファイル実体（f/*）と一時キーは除外。
  const kv: Record<string, string> = {};
  let cursor: string | undefined;
  do {
    const page = await env.LICENSE.list({ cursor });
    for (const k of page.keys) {
      const name = k.name;
      if (name.startsWith(FILE_PREFIX) || EPHEMERAL_KV.some((p) => name.startsWith(p))) continue;
      const val = await env.LICENSE.get(name);
      if (val == null) continue;
      if (opts.decrypt && name.startsWith("apikey:")) {
        try { kv[name] = await decryptField(key, val, "api-keys"); } catch { kv[name] = val; }
      } else {
        kv[name] = val;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // 3) ファイル実体（R2/KV）。plain=b64 が平文か否か。dbEnc=files 行の enc（復元時の目標状態）。
  const files: FileEntry[] = [];
  const fileRows = (await env.DB.prepare("SELECT id,name,mime,ref,enc FROM files WHERE deleted_at IS NULL AND ref<>''")
    .all<{ id: string; name: string; mime: string | null; ref: string; enc: number }>()).results;
  for (const f of fileRows) {
    const raw = await readRawBlob(env, f.ref);
    if (!raw) continue;
    let bytes = raw;
    let plain = f.enc === 0; // 元々非暗号なら平文
    if (opts.decrypt && f.enc) {
      try { bytes = await decryptBytes(key, raw, "files"); plain = true; } catch { bytes = raw; plain = false; }
    }
    files.push({ id: f.id, ref: f.ref, dbEnc: f.enc, plain, name: f.name, mime: f.mime, b64: bufToB64(bytes) });
  }

  const archive: Archive = {
    format: "baku-office-backup",
    version: 1,
    createdAt: nowSec(),
    appVersion: APP_VERSION,
    schemaVersion: await env.LICENSE.get("schema_version"),
    decrypted: opts.decrypt,
    d1, kv, files,
  };
  return { json: JSON.stringify(archive), tables: tableNames.length, files: files.length };
}

export function backupFileName(decrypt: boolean): string {
  // 日付はファイル名に入れない（Date 依存を避け、サーバ側 nowSec をアーカイブ内 createdAt に持つ）。
  return `baku-office-backup-${decrypt ? "decrypted" : "encrypted"}.json`;
}

export async function recordBackupDone(env: Env, dest: "local" | "drive", mode: BackupMode, tables: number, files: number): Promise<void> {
  await setBackupState(env, { lastAt: nowSec(), dest, mode, tables, files });
}

// ── 復元 ───────────────────────────────────────────────────────────────────
// アーカイブから D1・KV・ファイル実体を書き戻す。空の別環境への移行を主用途とする
// （既存行は INSERT OR REPLACE で上書き、アーカイブに無い行は残るため完全な巻き戻しではない）。
export async function restoreBackup(env: Env, archive: unknown): Promise<{ tables: number; rows: number; kv: number; files: number }> {
  const a = archive as Archive;
  if (!a || a.format !== "baku-office-backup") throw new Error("バックアップ形式が不正です。");
  await applyMigrations(env); // 復元先にテーブルが無い場合に備え冪等適用。
  const key = await masterKey(env);

  // 1) D1 行（INSERT OR REPLACE）。decrypted アーカイブの users.display_name は復元先の鍵で再暗号化。
  let rowCount = 0;
  for (const [table, { rows }] of Object.entries(a.d1 ?? {})) {
    for (const row of rows) {
      const r = { ...row };
      if (a.decrypted && table === "users" && r.display_name) {
        r.display_name = await encryptField(key, String(r.display_name), "member-pii");
      }
      const cols = Object.keys(r);
      if (!cols.length) continue;
      const ph = cols.map(() => "?").join(",");
      const colSql = cols.map((c) => `"${c}"`).join(",");
      await env.DB.prepare(`INSERT OR REPLACE INTO "${table}" (${colSql}) VALUES (${ph})`).bind(...cols.map((c) => r[c] as never)).run();
      rowCount++;
    }
  }

  // 2) KV。decrypted は master_key を書かない（復元先の鍵を温存）。apikey:* は再暗号化。raw は鍵も含め全て書く。
  let kvCount = 0;
  for (const [name, val] of Object.entries(a.kv ?? {})) {
    if (a.decrypted && name === "master_key") continue;
    let out = val;
    if (a.decrypted && name.startsWith("apikey:")) out = await encryptField(key, val, "api-keys");
    await kvPut(env, name, out);
    kvCount++;
  }

  // 3) ファイル実体。dbEnc=1 かつ平文なら再暗号化して書く。dbEnc=1 かつ暗号文ならそのまま。dbEnc=0 は平文のまま。
  let fileCount = 0;
  for (const f of a.files ?? []) {
    let bytes = b64ToBuf(f.b64);
    if (f.dbEnc === 1 && f.plain) bytes = await encryptBytes(key, bytes, "files");
    await putRawBlob(env, f.ref, bytes);
    fileCount++;
  }

  return { tables: Object.keys(a.d1 ?? {}).length, rows: rowCount, kv: kvCount, files: fileCount };
}
