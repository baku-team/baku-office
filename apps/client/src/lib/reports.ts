// クライアント側の報告：自動エラー報告・不具合/要望リクエストをアウトボックスに貯め、
// cron/drain でホスト(/api/report)へまとめて送る。ホストからの対応返信も保持・表示する。
// PII を載せない方針：本文/コンテキストは要約・スタック等に限る（呼び出し側で配慮）。
import { randomId, type ReportUpdate } from "@baku-office/shared";
import { hostFetch, getToken, APP_VERSION } from "./client.ts";
import { nowSec } from "./accounting.ts";

// 報告をアウトボックスへ積む（送信は flushReports）。エラー自動報告・要望どちらも。
export async function enqueueReport(env: Env, r: { kind: "error" | "request"; severity?: string; category?: string; title?: string; message: string; context?: string; fingerprint?: string }): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO client_report_outbox (id,kind,severity,category,title,message,context,fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).bind(randomId(), r.kind, r.severity ?? null, r.category ?? null, r.title ?? null, r.message.slice(0, 2000), (r.context ?? "").slice(0, 2000) || null, r.fingerprint ?? null, nowSec()).run();
  } catch { /* アウトボックス書き込み失敗は本処理を止めない */ }
}

// 未送信の報告をホストへバッチ送信。成功分は sent=1。ライセンス未取得時は何もしない。
export async function flushReports(env: Env, limit = 25): Promise<number> {
  const token = await getToken(env);
  if (!token) return 0;
  const { results } = await env.DB.prepare(
    "SELECT id,kind,severity,category,title,message,context,fingerprint FROM client_report_outbox WHERE sent=0 ORDER BY created_at ASC LIMIT ?",
  ).bind(limit).all<{ id: string; kind: string; severity: string | null; category: string | null; title: string | null; message: string; context: string | null; fingerprint: string | null }>();
  if (!results.length) return 0;
  const reports = results.map((r) => ({ kind: r.kind, severity: r.severity ?? undefined, category: r.category ?? undefined, title: r.title ?? undefined, message: r.message, context: r.context ?? undefined, fingerprint: r.fingerprint ?? undefined, appVersion: APP_VERSION }));
  try {
    const resp = await hostFetch(env, "/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, reports }) });
    if (!resp.ok) {
      const ph = results.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE client_report_outbox SET attempts=attempts+1 WHERE id IN (${ph})`).bind(...results.map((r) => r.id)).run().catch(() => {});
      return 0;
    }
  } catch {
    return 0;
  }
  const ph = results.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE client_report_outbox SET sent=1 WHERE id IN (${ph})`).bind(...results.map((r) => r.id)).run().catch(() => {});
  return results.length;
}

// ホストからの対応返信（resolved/wontfix）を保存（統合チェックで受領→表示用）。
export async function applyReportUpdates(env: Env, updates: ReportUpdate[]): Promise<void> {
  for (const u of updates.slice(0, 20)) {
    await env.DB.prepare(
      "INSERT INTO host_report_replies (id,kind,title,status,resolution,pr_url,received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, resolution=excluded.resolution, pr_url=excluded.pr_url, received_at=excluded.received_at",
    ).bind(u.id, u.kind ?? null, u.title ?? null, u.status ?? null, u.resolution ?? null, u.pr_url ?? null, nowSec()).run().catch(() => {});
  }
}

export async function listReplies(env: Env, limit = 30): Promise<{ id: string; kind: string | null; title: string | null; status: string | null; resolution: string | null; pr_url: string | null; received_at: number }[]> {
  return (await env.DB.prepare("SELECT id,kind,title,status,resolution,pr_url,received_at FROM host_report_replies ORDER BY received_at DESC LIMIT ?").bind(limit).all<{ id: string; kind: string | null; title: string | null; status: string | null; resolution: string | null; pr_url: string | null; received_at: number }>()).results;
}

// 利用者からの不具合/要望リクエスト（手動）。アウトボックスへ積み、その場で送信を試みる。
export async function submitFeedback(env: Env, f: { title?: string; message: string }): Promise<{ ok: boolean; error?: string }> {
  if (!f.message || !f.message.trim()) return { ok: false, error: "内容を入力してください" };
  await enqueueReport(env, { kind: "request", category: "feedback", title: f.title?.slice(0, 120), message: f.message });
  await flushReports(env).catch(() => 0);
  return { ok: true };
}
