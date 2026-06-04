import { defineMiddleware } from "astro:middleware";
import { getToken } from "./lib/client.ts";

// ライセンス未保持なら /activate へ誘導（§4：初回起動で自動アクティベーション）。
// /activate・/api/*・静的アセットは除外。
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const exempt = pathname.startsWith("/activate") || pathname.startsWith("/api/") || pathname.includes(".");
  if (exempt) return next();

  const env = context.locals.runtime.env;
  const token = await getToken(env);
  if (!token) return context.redirect("/activate", 302);
  return next();
});
