import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { getLogo, storeLogo, clearLogo } from "../../lib/logo.ts";
import { getTheme, setTheme } from "../../core/theme.ts";
import { nowSec } from "../../lib/client.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const MAX = 3 * 1024 * 1024; // 3MB
const b64ToBuf = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

// ロゴ画像の配信（ブラウザの <img> 用）。機微情報でないため認証は課さない（同一オリジン配信）。
export const GET: APIRoute = async () => {
  const m = await getLogo(env).catch(() => null);
  if (!m) return new Response("not found", { status: 404 });
  return new Response(m.buf, { status: 200, headers: { "content-type": m.ct, "cache-control": "public, max-age=600" } });
};

// アップロード / 既定（ロゴなし）に戻す。管理者(org)のみ。CSRF は middleware の sameOrigin で担保。
// SVG は受け付けない（同一オリジン配信のため script 入り SVG が XSS になり得る）。
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "権限がありません（管理者のみ）" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; dataB64?: string; mime?: string };

  switch (b._action) {
    case "reset": {
      await clearLogo(env);
      const { logoUrl: _drop, ...rest } = await getTheme(ctx);
      await setTheme(ctx, rest);
      return json({ ok: true, logoUrl: "" });
    }
    case "upload": {
      const mime = String(b.mime || "");
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return json({ error: "画像（PNG/JPEG/WebP/GIF）のみ対応" }, 400);
      let buf: ArrayBuffer;
      try { buf = b64ToBuf(b.dataB64 || ""); } catch { return json({ error: "画像データが不正です" }, 400); }
      if (buf.byteLength === 0) return json({ error: "画像が空です" }, 400);
      if (buf.byteLength > MAX) return json({ error: "画像が大きすぎます（3MBまで）" }, 400);
      await storeLogo(env, buf, mime);
      const t = await getTheme(ctx);
      const logoUrl = "/api/logo?v=" + nowSec();
      await setTheme(ctx, { ...t, logoUrl });
      return json({ ok: true, logoUrl });
    }
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
