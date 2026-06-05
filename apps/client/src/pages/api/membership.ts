import type { APIRoute } from "astro";
import { getSession, canAccess } from "../../lib/auth.ts";
import { createMember, updateMember, deleteMember } from "../../lib/membership.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 会員管理（Free以上＝全プラン）。編集は admin / accounting（会計担当）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org") return json({ error: "組織ログインが必要" }, 403);
  if (!canAccess(ses.role, "accounting")) return json({ error: "会計担当または管理者のみ" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; name?: string; contact?: string; fee_status?: string; paid_at?: string; extra?: string };
  switch (b._action) {
    case "create":
      if (!b.name) return json({ error: "氏名が必要" }, 400);
      return json({ ok: true, id: await createMember(env, { name: b.name, contact: b.contact, fee_status: b.fee_status, paid_at: b.paid_at, extra: b.extra }) });
    case "update":
      if (!b.id) return json({ error: "id が必要" }, 400);
      await updateMember(env, b.id, { name: b.name, contact: b.contact, fee_status: b.fee_status, paid_at: b.paid_at, extra: b.extra });
      return json({ ok: true });
    case "delete":
      if (b.id) await deleteMember(env, b.id);
      return json({ ok: true });
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
