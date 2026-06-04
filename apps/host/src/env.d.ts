/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  PORTAL: KVNamespace;
  ASSETS: Fetcher;
  LATEST_VERSION: string;
  // secrets（wrangler secret put）
  SIGNING_JWK?: string; // ライセンス署名（Ed25519秘密鍵JWK）
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_KEY?: string;
  // スタッフ管理者のGoogleメール（カンマ区切り）。ここに含まれるアカウントのみ管理ポータルを操作可。
  HOST_ADMIN_EMAILS?: string;
  // Stripe（§2・P5）。未設定のdevでは dev-confirm で入金をシミュレート。
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_Y?: string;
  STRIPE_PRICE_Z?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
