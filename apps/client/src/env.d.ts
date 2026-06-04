/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  LICENSE: KVNamespace;
  MEDIA: KVNamespace;
  ASSETS: Fetcher;
  HOST_BASE_URL: string;
  // 同一アカウントでの host への配信路（workers.dev同士の直fetchはCFが遮断＝error1042）。
  // 別アカウント（本番の自己ホスト）では未設定＝HOST_BASE_URL(カスタムドメイン)へURL fetch。
  HOST?: Fetcher;
  // secrets（wrangler secret put）
  MASTER_KEY?: string;
  VERIFY_PUBLIC_JWK?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // R2 高度モード（任意）
  MEDIA_R2?: R2Bucket;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
