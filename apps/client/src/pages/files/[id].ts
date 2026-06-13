import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { getFileForSession } from "../../lib/storage.ts";
import { env } from "cloudflare:workers";

export const prerender = false;

// ファイルダウンロード（ログイン必須＋所有者/ロール検査・P0-1）。
export const GET: APIRoute = async ({ params, request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses) return new Response("ログインが必要", { status: 401 });
  const id = params.id;
  if (!id) return new Response("not found", { status: 404 });
  // スコープ外は存在しない扱い（404）でIDの有無もリークさせない。
  const f = await getFileForSession(env, id, ses);
  if (!f) return new Response("not found", { status: 404 });
  return new Response(f.buf, {
    headers: {
      "content-type": f.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    },
  });
};
