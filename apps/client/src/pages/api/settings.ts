import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { setMaxUploadMb } from "../../lib/storage.ts";
import { setAiEngine, setCustomPrompt } from "../../lib/settings.ts";
import { setStorageLimits } from "../../lib/storage-usage.ts";
import { partCatalog, enabledPartIds, setEnabledPartIds } from "../../core/parts.ts";
import { setTheme } from "../../core/theme.ts";
import { setNavOverrides } from "../../core/nav.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 高度なオプションの各種設定（管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; mb?: number; engine?: string; prompt?: string; limits?: Record<string, number>; parts?: string[]; theme?: unknown; nav?: { hidden?: string[]; labels?: Record<string, string>; order?: string[] } };
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
  // 有効パーツの選択（団体ごとの組み立て・§5）。
  if (b._action === "enabled_parts") {
    const v = await setEnabledPartIds(locals.ctx, Array.isArray(b.parts) ? b.parts : []);
    return json({ ok: true, enabled: v, catalog: partCatalog() });
  }
  if (b._action === "list_parts") {
    return json({ ok: true, enabled: await enabledPartIds(locals.ctx), catalog: partCatalog() });
  }
  // UIテーマ（第1層）。
  if (b._action === "ui_theme") {
    const v = await setTheme(locals.ctx, b.theme);
    return json({ ok: true, theme: v });
  }
  // ナビ上書き（第2層）。
  if (b._action === "nav_overrides") {
    const v = await setNavOverrides(locals.ctx, b.nav ?? {});
    return json({ ok: true, nav: v });
  }
  return json({ error: "不明な操作" }, 400);
};
