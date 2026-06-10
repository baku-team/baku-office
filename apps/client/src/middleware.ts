import { defineMiddleware } from "astro:middleware";
import { getToken } from "./lib/client.ts";
import { ensureSchema } from "./lib/migrate.ts";
import { bootCheck } from "./lib/boot-check.ts";
import { buildCtx } from "./core/ctx.ts";

// XSS の最終防衛線。is:inline スクリプト多数のため script/style は 'unsafe-inline' 許容（nonce移行は別課題）。
// object/base/frame は厳格化し、外部送信先は同一オリジンに限定（AI/外部APIはサーバ側で呼ぶ）。
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function withSec(res: Response): Response {
  res.headers.set("Content-Security-Policy", CSP);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return res;
}

// ライセンス未保持なら /activate へ誘導（§4）。アプリ全体の前段でスキーマ自動適用も行う。
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const env = context.locals.runtime.env;

  // ポータブルコアの実行コンテキストを注入（移植性アーキ §7）。以後 ctx.db/storage/ai/agent 経由で呼ぶ。
  context.locals.ctx = buildCtx(env);

  // DBスキーマを最新へ自動適用（自己ホスト・upstream更新で増えた分を初回に反映）。
  await ensureSchema(env);
  // 本番の env 設定漏れを初回1回だけ点検し診断へ（§7・action#7）。
  await bootCheck(env);

  const exempt = pathname.startsWith("/activate") || pathname.startsWith("/api/") || pathname.includes(".");
  if (exempt) return withSec(await next());

  const token = await getToken(env);
  if (!token) {
    // LICENSE_ID が設定されていれば自動アクティベート（アプリを開くだけで完了）。無ければ手動入力画面へ。
    if (env.LICENSE_ID) return withSec(context.redirect("/activate?license_id=" + encodeURIComponent(env.LICENSE_ID), 302));
    return withSec(context.redirect("/activate", 302));
  }
  return withSec(await next());
});
