import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { listApprovals, decideApproval, getApproval } from "../../lib/approvals.ts";
import { runApprovedTool } from "../../lib/agent.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// エージェントの破壊的/対外操作の承認（管理者・org）。一覧／承認（実行）／却下（P0-4）。
export const POST: APIRoute = async ({ request, locals, url }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string };

  if (b._action === "list") {
    return json({ ok: true, pending: await listApprovals(env, "pending") });
  }
  if (b._action === "approve" || b._action === "reject") {
    const id = String(b.id ?? "");
    const a = await getApproval(env, id);
    if (!a) return json({ error: "承認が見つかりません" }, 404);
    const r = await decideApproval(env, id, b._action === "approve", ses.uid, (tool, args) =>
      runApprovedTool(locals.ctx, a.owner, url.origin, "admin", tool, args),
    );
    return r.ok ? json({ ok: true, result: r.result }) : json({ error: r.error }, 400);
  }
  return json({ error: "不明な操作" }, 400);
};
