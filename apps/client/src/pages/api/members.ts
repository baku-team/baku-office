import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { createInvite, approveUser, rejectUser, setRole, deleteUser, activeAdminCount } from "../../lib/users.ts";
import type { Role } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 人管理（§6.4：管理者のみ）。招待発行・承認・却下・ロール変更。
export const POST: APIRoute = async ({ request, locals }) => {
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
    case "delete": {
      // 名簿から完全削除（取り消し不可）。ロックアウト/自己破壊/システムユーザー破壊を防ぐ。
      if (!b.id) return json({ error: "対象がありません" }, 400);
      if (b.id === "org") return json({ error: "システムユーザーは削除できません" }, 400);
      if (b.id === ses.uid) return json({ error: "自分自身は削除できません" }, 400);
      const u = await env.DB.prepare("SELECT role,status FROM users WHERE id=?").bind(b.id).first<{ role: string; status: string }>();
      if (!u) return json({ error: "対象が見つかりません" }, 404);
      if (u.role === "admin" && u.status === "active" && (await activeAdminCount(env)) <= 1) {
        return json({ error: "最後の管理者は削除できません" }, 400);
      }
      await deleteUser(env, b.id);
      return json({ ok: true });
    }
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
