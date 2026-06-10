import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth.ts";
import { requestLeave, cancelLeave, activeAdminCount } from "../../../lib/users.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 本人によるアカウント脱退申請（§GA・会員セルフサービス）。CSRFは middleware の sameOrigin で担保。
// 業務データは団体に帰属するため削除しない＝アカウント無効化（脱退）を「申請→管理者承認」で行う。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org") return json({ error: "ログインが必要です" }, 403);
  // ブートストラップ管理者(org)は脱退対象外。最後の管理者の脱退はロックアウト防止のため拒否。
  if (ses.uid === "org") return json({ error: "この管理者アカウントは脱退できません" }, 400);
  if (ses.role === "admin" && (await activeAdminCount(env)) <= 1) {
    return json({ error: "最後の管理者は脱退できません。先に別の管理者を指定してください。" }, 400);
  }
  await requestLeave(env, ses.uid);
  return json({ ok: true });
};

// 申請の取り消し。
export const DELETE: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "org") return json({ error: "ログインが必要です" }, 403);
  await cancelLeave(env, ses.uid);
  return json({ ok: true });
};
