// クライアント報告（自動エラー・不具合/要望）の集積と統制（自己修復ログの中枢）。
// 方針：人間/外部サービスに依存せず、ここに集積→任意でGitHubへ同期→Claudeが巡回・修復。
import { nowSec, randomId } from "./host.ts";
import { createIssue } from "@baku-office/shared";

export type ReportInput = {
  licenseId: string | null;
  kind: "error" | "request";
  severity?: string | null;
  category?: string | null;
  title?: string | null;
  message: string;
  context?: string | null;
  appVersion?: string | null;
  fingerprint?: string | null;
};

export type ReportRow = {
  id: string; license_id: string | null; kind: string; severity: string | null; category: string | null;
  title: string | null; message: string; context: string | null; app_version: string | null;
  fingerprint: string | null; count: number; status: string; resolution: string | null;
  pr_url: string | null; issue_url: string | null; created_at: number; updated_at: number;
};

// 報告の取り込み（重複は fingerprint で集約し count++・最新メッセージで更新）。open/triaged のみ集約対象。
export async function recordReport(env: Env, r: ReportInput): Promise<{ id: string; deduped: boolean }> {
  const now = nowSec();
  const fp = (r.fingerprint || `${r.licenseId ?? "-"}:${r.kind}:${r.category ?? "-"}:${(r.title ?? r.message).slice(0, 80)}`).slice(0, 200);
  if (r.kind === "error") {
    const dup = await env.DB.prepare(
      "SELECT id FROM client_reports WHERE fingerprint=? AND status IN ('open','triaged','synced') ORDER BY updated_at DESC LIMIT 1",
    ).bind(fp).first<{ id: string }>();
    if (dup) {
      await env.DB.prepare("UPDATE client_reports SET count=count+1, message=?, context=?, app_version=COALESCE(?,app_version), updated_at=? WHERE id=?")
        .bind(r.message.slice(0, 2000), (r.context ?? "").slice(0, 2000) || null, r.appVersion ?? null, now, dup.id).run();
      return { id: dup.id, deduped: true };
    }
  }
  const id = randomId(10);
  await env.DB.prepare(
    `INSERT INTO client_reports (id,license_id,kind,severity,category,title,message,context,app_version,fingerprint,count,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 1, 'open', ?, ?)`,
  ).bind(id, r.licenseId, r.kind, r.severity ?? null, r.category ?? null, r.title ?? null, r.message.slice(0, 2000), (r.context ?? "").slice(0, 2000) || null, r.appVersion ?? null, fp, now, now).run();
  return { id, deduped: false };
}

export async function listReports(env: Env, opts: { status?: string; kind?: string; limit?: number } = {}): Promise<ReportRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.status && ["open", "triaged", "synced", "resolved", "wontfix"].includes(opts.status)) { where.push("status=?"); binds.push(opts.status); }
  if (opts.kind && ["error", "request"].includes(opts.kind)) { where.push("kind=?"); binds.push(opts.kind); }
  const wsql = where.length ? "WHERE " + where.join(" AND ") : "";
  binds.push(Math.min(opts.limit ?? 200, 500));
  return (await env.DB.prepare(`SELECT * FROM client_reports ${wsql} ORDER BY updated_at DESC LIMIT ?`).bind(...binds).all<ReportRow>()).results;
}

export async function getReport(env: Env, id: string): Promise<ReportRow | null> {
  return (await env.DB.prepare("SELECT * FROM client_reports WHERE id=?").bind(id).first<ReportRow>()) ?? null;
}

// 報告の状態更新（triaged/synced/resolved/wontfix）＋対応メモ/PR URL。
export async function updateReport(env: Env, id: string, patch: { status?: string; resolution?: string; prUrl?: string }): Promise<{ ok: boolean; error?: string }> {
  const sets: string[] = ["updated_at=?"];
  const binds: unknown[] = [nowSec()];
  if (patch.status) {
    if (!["open", "triaged", "synced", "resolved", "wontfix"].includes(patch.status)) return { ok: false, error: "不正な状態" };
    sets.push("status=?"); binds.push(patch.status);
  }
  if (patch.resolution !== undefined) { sets.push("resolution=?"); binds.push(patch.resolution.slice(0, 1000) || null); }
  if (patch.prUrl !== undefined) { sets.push("pr_url=?"); binds.push(patch.prUrl || null); }
  binds.push(id);
  await env.DB.prepare(`UPDATE client_reports SET ${sets.join(",")} WHERE id=?`).bind(...binds).run();
  return { ok: true };
}

// この団体への対応返信（クライアントへ返信表示用）。resolved/wontfix の直近分のみ。
export async function reportUpdatesFor(env: Env, licenseId: string, sinceSec = 30 * 86400): Promise<import("@baku-office/shared").ReportUpdate[]> {
  const { results } = await env.DB.prepare(
    "SELECT id,kind,title,status,resolution,pr_url,updated_at FROM client_reports WHERE license_id=? AND status IN ('resolved','wontfix') AND updated_at>=? ORDER BY updated_at DESC LIMIT 20",
  ).bind(licenseId, nowSec() - sinceSec).all<{ id: string; kind: string; title: string | null; status: string; resolution: string | null; pr_url: string | null; updated_at: number }>();
  return results.map((r) => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, resolution: r.resolution, pr_url: r.pr_url, updated_at: r.updated_at }));
}

// GitHubへ集積（Issue化）。集積先は GITHUB_LOGS_REPO（既定 baku-office-logs）。GITHUB_TOKEN 必須。
// 成功時 issue_url を保存し status を synced に。Claude はこの Issue を巡回・修復する。
export async function syncReportToGithub(env: Env, id: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  const token = env.GITHUB_TOKEN;
  const owner = env.GITHUB_OWNER;
  if (!token || !owner) return { ok: false, error: "GITHUB_TOKEN/GITHUB_OWNER 未設定（CF集積のみ可）" };
  const repo = env.GITHUB_LOGS_REPO || "baku-office-logs";
  const r = await getReport(env, id);
  if (!r) return { ok: false, error: "報告が見つかりません" };
  const labels = [r.kind === "error" ? "auto-report" : "request", `cat:${r.category ?? "other"}`];
  const body = [
    `**種別**: ${r.kind} / **重大度**: ${r.severity ?? "-"} / **分類**: ${r.category ?? "-"}`,
    `**団体ライセンス**: ${r.license_id ?? "-"} / **版**: ${r.app_version ?? "-"} / **再発**: ${r.count}`,
    "", "### 内容", r.message, "",
    r.context ? "### コンテキスト\n```\n" + r.context + "\n```" : "",
    "", "---", "_baku-office 自動集積。クラウドで修正可能ならPR作成→このIssueにリンク。不能なら原因と対策をレポート化しPRへ。_",
  ].join("\n");
  try {
    const url = await createIssue({ token, owner, repo }, { title: `[${r.kind}] ${(r.title ?? r.message).slice(0, 100)}`, body, labels });
    await env.DB.prepare("UPDATE client_reports SET issue_url=?, status=CASE WHEN status IN ('open','triaged') THEN 'synced' ELSE status END, updated_at=? WHERE id=?")
      .bind(url, nowSec(), id).run();
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// 未集積（open/triaged）のエラー報告を一括でGitHubへ集積（自己修復の定期巡回フックから呼べる）。
export async function syncOpenReports(env: Env, limit = 20): Promise<{ synced: number; failed: number }> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM client_reports WHERE kind='error' AND status IN ('open','triaged') AND issue_url IS NULL ORDER BY updated_at DESC LIMIT ?",
  ).bind(limit).all<{ id: string }>();
  let synced = 0, failed = 0;
  for (const row of results) {
    const r = await syncReportToGithub(env, row.id);
    if (r.ok) synced++; else failed++;
  }
  return { synced, failed };
}
