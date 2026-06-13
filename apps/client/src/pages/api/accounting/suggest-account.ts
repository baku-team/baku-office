import type { APIRoute } from "astro";
import { atLeast } from "@baku-office/shared";
import { requireOrgAdmin } from "../../../lib/auth.ts";
import { cachedEntitlement } from "../../../lib/client.ts";
import { listAccountItems } from "../../../lib/account-items.ts";
import { suggestAccountItem } from "../../../lib/media-ai.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 経費の勘定科目をAIが推定（Plus以上）。候補は勘定科目マスタ。手動上書き前提なので失敗は null を返す。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env).catch(() => "free" as const), "plus")) {
    return json({ error: "AI勘定科目推定は Plus 以上で利用できます" }, 402);
  }
  const b = (await request.json().catch(() => ({}))) as { vendor?: string; description?: string; amount?: number };
  const items = await listAccountItems(env, { enabledOnly: true });
  // 費用科目を優先候補に（経費の推定なので）。無ければ全科目。
  const expense = items.filter((a) => a.major === "expense");
  const candidates = (expense.length ? expense : items).map((a) => ({ code: a.code, name: a.name }));
  const sug = await suggestAccountItem(env, { vendor: b.vendor, description: b.description, amount: b.amount }, candidates);
  if (!sug) return json({ ok: true, suggestion: null });
  const hit = items.find((a) => a.code === sug.code);
  return json({ ok: true, suggestion: hit ? { id: hit.id, code: hit.code, name: hit.name, reason: sug.reason } : null });
};
