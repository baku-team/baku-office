import { defineMiddleware } from "astro:middleware";
import { getToken } from "./lib/client.ts";
import { ensureSchema } from "./lib/migrate.ts";
import { bootCheck } from "./lib/boot-check.ts";
import { sameOrigin } from "./lib/auth.ts";
import { buildCtx } from "./core/ctx.ts";

// ログイン誘導を素通りさせる静的アセットの拡張子 allowlist。
// WHY: 旧実装は「`.` を含む全パス」を exempt にしており /accounting/export.csv 等の動的ルートまで
//   ログイン誘導から外れていた（P0-1の温床）。拡張子を絞り、動的ルートは保護下に戻す。
const STATIC_EXT = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|txt|json|xml|webmanifest)$/i;

// 状態変更メソッド（CSRF対象）。webhook/cron/A2A は別の検証を持つため後段で除外する。
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// 正当な対外/内部POSTで同一オリジン判定を免除する経路（各々が独自の検証を持つ）。
// Stripe/LINE=Webhook署名、A2A=Ed25519署名、cron drain=INTERNAL_KEY。
const CSRF_EXEMPT = new Set([
  "/api/site/stripe-webhook",
  "/api/line/webhook",
  "/api/a2a/inbound",
  "/api/cron/drain",
]);

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

  // CSRF 多層防御（P1-1）：状態変更API（/api/ の POST/PUT/PATCH/DELETE）は同一オリジン必須。
  // webhook/cron/A2A は対外/内部からの正当POSTのため除外（各自で署名/共有秘密を検証）。
  if (
    pathname.startsWith("/api/") &&
    UNSAFE_METHODS.has(context.request.method) &&
    !CSRF_EXEMPT.has(pathname) &&
    !sameOrigin(context.request)
  ) {
    return withSec(
      new Response(JSON.stringify({ error: "cross-site request rejected" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  const exempt = pathname.startsWith("/activate") || pathname.startsWith("/api/") || STATIC_EXT.test(pathname);
  if (exempt) return withSec(await next());

  const token = await getToken(env);
  if (!token) {
    // LICENSE_ID が設定されていれば自動アクティベート（アプリを開くだけで完了）。無ければ手動入力画面へ。
    if (env.LICENSE_ID) return withSec(context.redirect("/activate?license_id=" + encodeURIComponent(env.LICENSE_ID), 302));
    return withSec(context.redirect("/activate", 302));
  }
  return withSec(await next());
});
