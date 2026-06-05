import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { setMaxUploadMb } from "../../lib/storage.ts";
import { setAiEngine, setCustomPrompt } from "../../lib/settings.ts";
import { setStorageLimits } from "../../lib/storage-usage.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 高度なオプションの各種設定（管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; mb?: number; engine?: string; prompt?: string; limits?: Record<string, number> };
  if (b._action === "max_upload") {
    const v = await setMaxUploadMb(env, Number(b.mb));
    return json({ ok: true, mb: v });
  }
  if (b._action === "ai_engine") {
    const v = await setAiEngine(env, String(b.engine ?? "gemini"));
    return json({ ok: true, engine: v });
  }
  if (b._action === "custom_prompt") {
    const v = await setCustomPrompt(env, String(b.prompt ?? ""));
    return json({ ok: true, prompt: v });
  }
  if (b._action === "storage_limits") {
    const inc = b.limits ?? {};
    const clean: Record<string, number> = {};
    for (const k of ["d1", "kv", "r2", "drive"]) {
      const v = Number(inc[k]);
      if (Number.isFinite(v) && v > 0) clean[k] = v; // GB単位
    }
    await setStorageLimits(env, clean);
    return json({ ok: true });
  }
  return json({ error: "不明な操作" }, 400);
};
