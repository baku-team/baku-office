import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { setMaxUploadMb } from "../../lib/storage.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 高度なオプションの各種設定（管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; mb?: number };
  if (b._action === "max_upload") {
    const v = await setMaxUploadMb(env, Number(b.mb));
    return json({ ok: true, mb: v });
  }
  return json({ error: "不明な操作" }, 400);
};
