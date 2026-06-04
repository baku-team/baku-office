import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { createPersonalItem, shareItem } from "../../lib/users.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 個人コンテキスト：個人アイテムの作成・組織への共有申請（→承認待ち §9）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.ctx !== "personal") return json({ error: "個人ログインが必要" }, 401);

  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (b._action === "create") {
    const id = await createPersonalItem(env, ses.uid, {
      type: String(b.type ?? "memo"),
      title: String(b.title ?? ""),
      body: b.body ? String(b.body) : undefined,
      amount: b.amount ? Number(b.amount) : undefined,
      date: b.date ? String(b.date) : undefined,
    });
    return json({ ok: true, id });
  }
  if (b._action === "share" && typeof b.id === "string") {
    await shareItem(env, b.id, ses.uid);
    return json({ ok: true });
  }
  return json({ error: "不明な操作" }, 400);
};
