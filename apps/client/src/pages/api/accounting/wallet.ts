import type { APIRoute } from "astro";
import { requireOrgAdmin } from "../../../lib/auth.ts";
import { ensureSeed, createWallet, softDeleteWallet } from "../../../lib/accounting.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 口座（お金の種類）の追加/削除。会計データと同基準＝admin+org のみ。
export const POST: APIRoute = async ({ request }) => {
  if (!(await requireOrgAdmin(env, request))) return json({ error: "管理者のみ" }, 403);
  await ensureSeed(env);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (b._action === "delete" && typeof b.id === "string") {
    // 取引のある口座は削除させない（残高・出納帳が壊れるため）。
    const used = await env.DB.prepare("SELECT 1 FROM transactions WHERE (wallet_id=? OR counter_wallet_id=?) AND deleted_at IS NULL LIMIT 1").bind(b.id, b.id).first();
    if (used) return json({ error: "この口座には取引があるため削除できません" }, 400);
    await softDeleteWallet(env, b.id);
    return json({ ok: true });
  }

  if (!b.name || !b.type) return json({ error: "名称と種類が必要" }, 400);
  const id = await createWallet(env, { name: String(b.name), type: String(b.type), opening_balance: Number(b.opening_balance) || 0 });
  return json({ ok: true, id });
};
