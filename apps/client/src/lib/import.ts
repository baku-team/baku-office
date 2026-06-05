// 外部資料インポート（Notion / Googleドライブ）。既定はメタのみ。
// インポート前に容量シミュレーション＋費用試算し、容量不足なら対策を提示。R2有効時のみ実ファイルを取り込む。
import { randomId } from "@baku-office/shared";
import { getApiKey } from "./client.ts";
import { nowSec } from "./accounting.ts";
import { driveAccessToken, listDriveFiles } from "./drive.ts";
import { saveFile } from "./storage.ts";
import { getStorageUsage } from "./storage-usage.ts";

const GB = 1024 * 1024 * 1024;
const META_BYTES_PER_ITEM = 600; // D1 1件あたりの概算
const R2_YEN_PER_GB_MONTH = 2.3; // R2 ストレージ概算（$0.015/GB-month × 約150円）

export type ImportSource = "drive" | "notion";
export type ImportCandidate = { ext_id: string; title: string; mime: string | null; size: number; url: string | null };

// 候補の取得（メタ）。
export async function listCandidates(env: Env, source: ImportSource): Promise<{ items: ImportCandidate[]; error?: string }> {
  if (source === "drive") {
    const rows = await listDriveFiles(env);
    if (!rows.length) return { items: [], error: "ドライブのメタが未同期です（ドライブ画面で同期してください）。" };
    return { items: rows.map((r) => ({ ext_id: r.id, title: r.name, mime: r.mime, size: r.size ?? 0, url: null })) };
  }
  // notion：トークンで検索（ページ/DB）。サイズは取得しないため 0（メタのみ前提）。
  const token = await getApiKey(env, "notion");
  if (!token) return { items: [], error: "Notion 連携が未設定です（連携設定で Notion トークンを登録してください）。" };
  const r = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28", "content-type": "application/json" },
    body: JSON.stringify({ page_size: 100 }),
  });
  if (!r.ok) return { items: [], error: `Notion ${r.status}` };
  const d = (await r.json()) as { results?: { id: string; url?: string; properties?: Record<string, unknown>; object: string }[] };
  const items = (d.results ?? []).map((p) => ({ ext_id: p.id, title: notionTitle(p), mime: p.object === "database" ? "notion/database" : "notion/page", size: 0, url: p.url ?? null }));
  return { items };
}
function notionTitle(p: { properties?: Record<string, unknown> }): string {
  try {
    const props = p.properties ?? {};
    for (const v of Object.values(props)) {
      const t = (v as { title?: { plain_text?: string }[] }).title;
      if (Array.isArray(t) && t[0]?.plain_text) return t[0].plain_text;
    }
  } catch { /* noop */ }
  return "（無題）";
}

export type Simulation = {
  count: number; totalBytes: number; metaBytes: number; binaryBytes: number;
  r2CostYen: number; d1Over: boolean; r2Over: boolean; r2Enabled: boolean; withFiles: boolean;
  advice: string[]; error?: string;
};

export async function simulateImport(env: Env, source: ImportSource, withFiles: boolean): Promise<Simulation> {
  const { items, error } = await listCandidates(env, source);
  const empty: Simulation = { count: 0, totalBytes: 0, metaBytes: 0, binaryBytes: 0, r2CostYen: 0, d1Over: false, r2Over: false, r2Enabled: !!env.MEDIA_R2, withFiles, advice: [] };
  if (error) return { ...empty, error };

  const r2Enabled = !!env.MEDIA_R2;
  const count = items.length;
  const totalBytes = items.reduce((a, b) => a + (b.size || 0), 0);
  const metaBytes = count * META_BYTES_PER_ITEM;
  const binaryBytes = withFiles && r2Enabled ? totalBytes : 0;
  const usage = await getStorageUsage(env);
  const d1 = usage.find((u) => u.key === "d1")!;
  const r2 = usage.find((u) => u.key === "r2")!;
  const d1Over = d1.used >= 0 && d1.used + metaBytes > d1.limit;
  const r2Over = binaryBytes > 0 && r2.used + binaryBytes > r2.limit;
  const r2CostYen = Math.round((binaryBytes / GB) * R2_YEN_PER_GB_MONTH);

  const advice: string[] = [];
  if (withFiles && !r2Enabled) advice.push("実ファイルの取り込みには R2 が必要です。高度なオプションから R2 を有効化してください（メタのみなら不要）。");
  if (d1Over) advice.push("D1 の上限に達する見込みです。高度なオプション → Workers Paid で拡張するか、対象を絞ってください。");
  if (r2Over) advice.push("R2 の上限に達する見込みです。高度なオプションで R2 上限を調整するか、メタのみ取り込みにしてください。");
  if (!advice.length) advice.push("現在の容量で取り込み可能です。");

  return { count, totalBytes, metaBytes, binaryBytes, r2CostYen, d1Over, r2Over, r2Enabled, withFiles, advice };
}

export async function runImport(env: Env, source: ImportSource, withFiles: boolean): Promise<{ imported: number; files: number; error?: string }> {
  const { items, error } = await listCandidates(env, source);
  if (error) return { imported: 0, files: 0, error };
  const doFiles = withFiles && !!env.MEDIA_R2 && source === "drive";
  const token = doFiles ? await driveAccessToken(env) : null;
  let imported = 0, files = 0;
  for (const it of items) {
    let fileId: string | null = null;
    if (doFiles && token && it.size > 0) {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${it.ext_id}?alt=media`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      if (r && r.ok) {
        const buf = await r.arrayBuffer();
        const f = new File([buf], it.title, { type: it.mime ?? "application/octet-stream" });
        const saved = await saveFile(env, f, `import:${source}`).catch(() => null);
        if (saved) { fileId = saved.id; files++; }
      }
    }
    await env.DB.prepare("INSERT INTO imported_items (id,source,ext_id,title,mime,size,url,file_id,imported_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(randomId(), source, it.ext_id, it.title, it.mime, it.size || null, it.url, fileId, nowSec()).run();
    imported++;
  }
  return { imported, files };
}

export async function listImported(env: Env): Promise<{ id: string; source: string; title: string; mime: string | null; size: number | null; file_id: string | null; imported_at: number }[]> {
  return (await env.DB.prepare("SELECT id,source,title,mime,size,file_id,imported_at FROM imported_items ORDER BY imported_at DESC LIMIT 300").all<{ id: string; source: string; title: string; mime: string | null; size: number | null; file_id: string | null; imported_at: number }>()).results;
}
