// 診断・エラーログ（§7.1/§13.3）。CF無料枠の制限（CPU時間・waitUntil・サブリクエスト等）に当たった可能性を
// 検知して記録し、UIで「高度なオプション→Workers Paid」を案内する。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

// CF制限に起因しそうなエラーメッセージの判定。
export function looksLikeLimit(msg: string): boolean {
  return /exceeded|cpu|time limit|too many subrequests|memory|Worker exceeded|limit|killed|terminated|1102|1027/i.test(msg);
}

export async function logDiag(env: Env, level: "error" | "warn" | "info", category: string, message: string, context = ""): Promise<void> {
  try {
    await env.DB.prepare("INSERT INTO diagnostics (id,level,category,message,context,created_at) VALUES (?,?,?,?,?,?)")
      .bind(randomId(), level, category, message.slice(0, 500), context.slice(0, 500), nowSec()).run();
  } catch { /* 診断記録自体の失敗は握りつぶす */ }
  // エラーは自動でホストへ報告（アウトボックスに積む。送信は cron/drain）。
  // migration はブート時に多発し得るため除外（起動ループを避ける）。circular import 回避のため直接 INSERT。
  if (level === "error" && category !== "migration") {
    try {
      const fp = `auto:${category}:${message.slice(0, 80)}`;
      const dup = await env.DB.prepare("SELECT 1 FROM client_report_outbox WHERE fingerprint=? AND sent=0 LIMIT 1").bind(fp).first().catch(() => null);
      if (!dup) {
        await env.DB.prepare("INSERT INTO client_report_outbox (id,kind,severity,category,title,message,context,fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(randomId(), "error", level, category, message.slice(0, 120), message.slice(0, 2000), context.slice(0, 2000) || null, fp, nowSec()).run();
      }
    } catch { /* アウトボックス未整備（旧スキーマ）等は無視 */ }
  }
}

export async function recentDiagnostics(env: Env, limit = 50): Promise<{ level: string; category: string; message: string; created_at: number }[]> {
  return (await env.DB.prepare("SELECT level,category,message,created_at FROM diagnostics ORDER BY created_at DESC LIMIT ?").bind(limit).all<{ level: string; category: string; message: string; created_at: number }>()).results;
}
export async function hasRecentLimitError(env: Env): Promise<boolean> {
  const since = nowSec() - 86400;
  const row = await env.DB.prepare("SELECT 1 FROM diagnostics WHERE category='limit' AND created_at>=? LIMIT 1").bind(since).first();
  return !!row;
}

// 重い処理のガード：失敗時に診断記録（CF制限らしければ category=limit）。
// 戻り値 {ok, error, limit}。limit=true のとき UI/返信で Workers Paid を案内する。
export async function guardHeavy<T>(env: Env, label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string; limit: boolean }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const limit = looksLikeLimit(msg);
    await logDiag(env, "error", limit ? "limit" : "other", `${label}: ${msg}`);
    return { ok: false, error: msg, limit };
  }
}

export const PAID_HINT =
  "処理がCloudflareの無料枠の制限（CPU時間・実行時間など）に達した可能性があります。" +
  "大きなファイルや重い処理を安定させるには、管理画面の【高度なオプション → Workers Paid】の案内に沿ってCloudflareの有料プラン(Workers Paid)へ切り替えてください。";
