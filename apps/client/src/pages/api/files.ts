import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { saveFile, softDeleteFileForSession, audit } from "../../lib/storage.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return json({ error: "ログインが必要" }, 401);

  const ct = request.headers.get("content-type") ?? "";
  // 削除（JSON）。
  if (ct.includes("application/json")) {
    const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string };
    if (b._action === "delete" && b.id) {
      // 所有者/ロール検査つき削除（P0-1）。スコープ外なら未変更＝404＋拒否を監査に残す。
      const ok = await softDeleteFileForSession(env, b.id, ses);
      await audit(env, ses.uid, ok ? "file.delete" : "file.delete.denied", b.id);
      if (!ok) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
    return json({ error: "不明な操作" }, 400);
  }
  // アップロード（multipart）。
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "file がありません" }, 400);
  try {
    const r = await saveFile(env, file, ses.uid, ses.ctx);
    await audit(env, ses.uid, "file.upload", r.id);
    return json({ ok: true, id: r.id, mode: r.mode });
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
};
