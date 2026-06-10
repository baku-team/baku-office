import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { createInvite, approveUser, rejectUser, setRole } from "../../lib/users.ts";
import type { Role } from "@baku-office/shared";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 人管理（§6.4：管理者のみ）。招待発行・承認・却下・ロール変更。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "権限がありません" }, 403);

  const b = (await request.json().catch(() => ({}))) as { _action?: string; role?: Role; id?: string };
  switch (b._action) {
    case "invite": {
      const code = await createInvite(env, ses.uid, (b.role ?? "member") as Role);
      return json({ ok: true, code });
    }
    case "approve":
      if (b.id) await approveUser(env, b.id);
      return json({ ok: true });
    case "reject":
    case "leave_approve": // 本人の脱退申請を承認＝アカウント無効化（rejectUser と同じ：disabled＋セッション失効＋申請フラグ解消）
      if (b.id) await rejectUser(env, b.id);
      return json({ ok: true });
    case "role":
      if (b.id && b.role) await setRole(env, b.id, b.role);
      return json({ ok: true });
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
