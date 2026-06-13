import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { getMascot, storeMascot, clearMascot } from "../../lib/mascot.ts";
import { getTheme, setTheme } from "../../core/theme.ts";
import { nowSec } from "../../lib/client.ts";
import { logDiag } from "../../lib/diag.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const MAX = 3 * 1024 * 1024; // 3MB
const b64ToBuf = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

// 相棒画像の配信（ブラウザの <img> 用）。機微情報でないため認証は課さない（同一オリジン配信）。
export const GET: APIRoute = async ({ locals }) => {
  const m = await getMascot(env).catch(() => null);
  if (!m) return new Response("not found", { status: 404 });
  return new Response(m.buf, { status: 200, headers: { "content-type": m.ct, "cache-control": "public, max-age=600" } });
};

// 生成（Workers AI）/ アップロード / 既定に戻す。管理者(org)のみ。CSRF は middleware の sameOrigin で担保。
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "権限がありません（管理者のみ）" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; prompt?: string; dataB64?: string; mime?: string };

  const setUrl = async () => {
    const t = await getTheme(ctx);
    await setTheme(ctx, { ...t, mascotUrl: "/api/mascot?v=" + nowSec() });
    return "/api/mascot?v=" + nowSec();
  };

  switch (b._action) {
    case "reset": {
      await clearMascot(env);
      const { mascotUrl: _drop, ...rest } = await getTheme(ctx);
      await setTheme(ctx, rest);
      return json({ ok: true, mascotUrl: "" });
    }
    case "upload": {
      const mime = String(b.mime || "");
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return json({ error: "画像（PNG/JPEG/WebP/GIF）のみ対応" }, 400);
      let buf: ArrayBuffer;
      try { buf = b64ToBuf(b.dataB64 || ""); } catch { return json({ error: "画像データが不正です" }, 400); }
      if (buf.byteLength === 0) return json({ error: "画像が空です" }, 400);
      if (buf.byteLength > MAX) return json({ error: "画像が大きすぎます（3MBまで）" }, 400);
      await storeMascot(env, buf, mime);
      return json({ ok: true, mascotUrl: await setUrl() });
    }
    case "generate": {
      if (!env.AI) return json({ error: "この環境では画像生成（Workers AI）が利用できません" }, 400);
      const p = String(b.prompt || "").trim();
      if (!p) return json({ error: "どんなキャラクターにするか説明を入力してください" }, 400);
      const prompt = `${p}. cute mascot character, single subject, centered, simple flat illustration, soft solid pastel background, friendly, clean, high quality`;
      try {
        const out = (await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt, steps: 6 })) as { image?: string };
        if (!out?.image) return json({ error: "生成に失敗しました。説明を変えて再試行してください。" }, 502);
        await storeMascot(env, b64ToBuf(out.image), "image/jpeg");
        return json({ ok: true, mascotUrl: await setUrl() });
      } catch (e) {
        await logDiag(env, "error", "mascot", `generate: ${(e as Error).message}`);
        return json({ error: "画像生成に失敗しました：" + (e as Error).message }, 500);
      }
    }
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
