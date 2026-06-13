import type { APIRoute } from "astro";
import { getHostSession } from "../../lib/hostauth.ts";
import { recordAudit } from "../../lib/host.ts";
import { blockEntry, setCertified, setReportStatus } from "../../lib/directory.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開ディレクトリの管理（ホスト管理者のみ）：掲載停止/解除・公式認証の付与/取消・通報の処理。
export const POST: APIRoute = async ({ request }) => {
  const ses = await getHostSession(env, request);
  if (!ses?.isAdmin) return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; license_id?: string; note?: string; report_id?: string; status?: string };
  const lic = String(b.license_id ?? "");

  if (b._action === "block") { await blockEntry(env, lic, true); await recordAudit(env, ses.email, "directory.block", lic, null); return json({ ok: true }); }
  if (b._action === "unblock") { await blockEntry(env, lic, false); await recordAudit(env, ses.email, "directory.unblock", lic, null); return json({ ok: true }); }
  // 公式認証（人と会って事業確認後に手動付与）。
  if (b._action === "certify") { await setCertified(env, lic, true, b.note ? String(b.note) : undefined); await recordAudit(env, ses.email, "directory.certify", lic, String(b.note ?? "")); return json({ ok: true }); }
  if (b._action === "uncertify") { await setCertified(env, lic, false); await recordAudit(env, ses.email, "directory.uncertify", lic, null); return json({ ok: true }); }
  // 通報の処理（対応済み/却下）。
  if (b._action === "report_status" && b.report_id) { await setReportStatus(env, String(b.report_id), b.status === "dismissed" ? "dismissed" : "reviewed"); return json({ ok: true }); }
  return json({ error: "不明な操作" }, 400);
};
