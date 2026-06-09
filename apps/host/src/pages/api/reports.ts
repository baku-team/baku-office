import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { recordAudit } from "../../lib/host.ts";
import { updateReport, syncReportToGithub, syncOpenReports } from "../../lib/reports.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// クライアント報告の統制（ホスト管理者のみ）：状態更新／対応メモ／GitHub集積。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; status?: string; resolution?: string; prUrl?: string; limit?: number };

  // 状態・対応メモ・PR URL の更新（resolved/wontfix は次回チェックでクライアントへ返信）。
  if (b._action === "update") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    const r = await updateReport(env, b.id, { status: b.status, resolution: b.resolution, prUrl: b.prUrl });
    if (!r.ok) return json({ error: r.error }, 400);
    await recordAudit(env, ses.email, "report.update", b.id, `status=${b.status ?? "-"}`);
    return json({ ok: true });
  }
  // 単一報告を GitHub Issue へ集積（自己修復の入口）。
  if (b._action === "sync") {
    if (!b.id) return json({ error: "id が必要" }, 400);
    const r = await syncReportToGithub(env, b.id);
    if (!r.ok) return json({ error: r.error }, 400);
    await recordAudit(env, ses.email, "report.sync", b.id, r.url ?? null);
    return json({ ok: true, url: r.url });
  }
  // 未集積エラーを一括集積。
  if (b._action === "sync_all") {
    const r = await syncOpenReports(env, b.limit ?? 20);
    await recordAudit(env, ses.email, "report.sync_all", null, `synced=${r.synced} failed=${r.failed}`);
    return json({ ok: true, ...r });
  }
  return json({ error: "不明な操作" }, 400);
};
