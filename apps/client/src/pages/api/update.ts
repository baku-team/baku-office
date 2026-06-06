import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { hasDeployHook, saveDeployHook, getDeployHook, clearDeployHook, isValidHookUrl } from "../../lib/update.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 自動更新（案①）：Deploy Hook の暗号化保存／状態／削除と、保存済みフックでの再ビルド発火（§3.3-3.4）。
// 管理者（組織）のみ。フックURLはホストへ送らずアプリKV内に暗号化保持（原則1）。
export const GET: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  return json({ configured: await hasDeployHook(env) });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; hookUrl?: string };

  if (b._action === "delete") {
    await clearDeployHook(env);
    return json({ ok: true });
  }

  if (b._action === "trigger") {
    const hook = await getDeployHook(env);
    if (!hook) return json({ ok: false, needGuide: true }); // 未設定＝案②へ
    try {
      const r = await fetch(hook, { method: "POST" });
      return r.ok ? json({ ok: true }) : json({ ok: false, error: "フック発火に失敗（" + r.status + "）" }, 502);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 502);
    }
  }

  // 既定：フック保存（形式検証→暗号化）。テスト発火はしない（次回更新時に使用）。
  const url = (b.hookUrl ?? "").trim();
  if (!isValidHookUrl(url)) return json({ ok: false, error: "Cloudflare の Deploy Hook URL を確認してください" }, 400);
  await saveDeployHook(env, url);
  return json({ ok: true });
};
