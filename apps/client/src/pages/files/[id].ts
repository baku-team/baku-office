import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { getFile } from "../../lib/storage.ts";

export const prerender = false;

// ファイルダウンロード（ログイン必須）。
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses) return new Response("ログインが必要", { status: 401 });
  const id = params.id;
  if (!id) return new Response("not found", { status: 404 });
  const f = await getFile(env, id);
  if (!f) return new Response("not found", { status: 404 });
  return new Response(f.buf, {
    headers: {
      "content-type": f.mime,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    },
  });
};
