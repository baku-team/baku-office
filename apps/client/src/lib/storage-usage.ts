// ストレージ使用量（D1 / KV / R2 / Googleドライブ）の集計と上限。全プランで可視化する。
// KV/R2 は files メタの size 合計、Drive は同期メタの size 合計。D1 は PRAGMA で概算（不可なら -1）。
import { driveConnected } from "./drive.ts";

const GB = 1024 * 1024 * 1024;

export type StorageStat = {
  key: "d1" | "kv" | "r2" | "drive";
  label: string;
  used: number;        // バイト（-1=計測不可）
  limit: number;       // バイト
  enabled: boolean;    // 利用可能か（R2=バインド有無 / Drive=連携済み）
  hint: "paid" | "r2" | "drive" | "none"; // 上限接近時の案内先
};

export const fmtBytes = (n: number): string => {
  if (n < 0) return "—";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  if (n < GB) return (n / 1024 / 1024).toFixed(1) + "MB";
  return (n / GB).toFixed(2) + "GB";
};

export async function getStorageLimits(env: Env): Promise<Partial<Record<string, number>>> {
  try { return JSON.parse((await env.LICENSE.get("storage_limits")) ?? "{}") as Partial<Record<string, number>>; } catch { return {}; }
}
export async function setStorageLimits(env: Env, l: Partial<Record<string, number>>): Promise<void> {
  await env.LICENSE.put("storage_limits", JSON.stringify(l ?? {}));
}

async function sumFiles(env: Env, like: string): Promise<number> {
  try { return (await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS s FROM files WHERE ref LIKE ? AND deleted_at IS NULL").bind(like).first<{ s: number }>())?.s ?? 0; } catch { return 0; }
}

export async function getStorageUsage(env: Env): Promise<StorageStat[]> {
  const lim = await getStorageLimits(env);
  // D1：PRAGMA page_count * page_size（D1 が対応していなければ -1）。
  let d1 = -1;
  try {
    const pc = (await env.DB.prepare("PRAGMA page_count").first<Record<string, number>>()) ?? {};
    const ps = (await env.DB.prepare("PRAGMA page_size").first<Record<string, number>>()) ?? {};
    const pcv = Object.values(pc)[0]; const psv = Object.values(ps)[0];
    if (typeof pcv === "number" && typeof psv === "number") d1 = pcv * psv;
  } catch { d1 = -1; }

  const kv = await sumFiles(env, "kv:%");
  const r2 = await sumFiles(env, "r2:%");
  let drive = 0;
  try { drive = (await env.DB.prepare("SELECT COALESCE(SUM(size),0) AS s FROM drive_files").first<{ s: number }>())?.s ?? 0; } catch { drive = 0; }
  const r2Enabled = !!env.MEDIA_R2;
  const driveOn = await driveConnected(env).catch(() => false);

  return [
    { key: "d1", label: "データベース（D1）", used: d1, limit: (lim.d1 ?? 5) * GB, enabled: true, hint: "paid" },
    { key: "kv", label: "ストレージ（KV）", used: kv, limit: (lim.kv ?? 1) * GB, enabled: true, hint: r2Enabled ? "paid" : "r2" },
    { key: "r2", label: "ストレージ（R2）", used: r2, limit: (lim.r2 ?? 10) * GB, enabled: r2Enabled, hint: "paid" },
    { key: "drive", label: "Googleドライブ", used: drive, limit: (lim.drive ?? 15) * GB, enabled: driveOn, hint: "drive" },
  ];
}
