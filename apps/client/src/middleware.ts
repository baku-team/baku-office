import { defineMiddleware } from "astro:middleware";
import { getToken } from "./lib/client.ts";
import { ensureSchema } from "./lib/migrate.ts";

// ライセンス未保持なら /activate へ誘導（§4）。アプリ全体の前段でスキーマ自動適用も行う。
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const env = context.locals.runtime.env;

  // DBスキーマを最新へ自動適用（自己ホスト・upstream更新で増えた分を初回に反映）。
  await ensureSchema(env);

  const exempt = pathname.startsWith("/activate") || pathname.startsWith("/api/") || pathname.includes(".");
  if (exempt) return next();

  const token = await getToken(env);
  if (!token) return context.redirect("/activate", 302);
  return next();
});
