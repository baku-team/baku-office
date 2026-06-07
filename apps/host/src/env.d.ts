/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  PORTAL: KVNamespace;
  ASSETS: Fetcher;
  LATEST_VERSION: string;
  // 申込専用Worker（baku-office-apply）のURL。ポータルから案内リンクを出す。
  APPLY_URL?: string;
  // 第2層更新（日和見ローダ）。恒久運用は CI が /api/release/publish で PORTAL KV に保存。
  // 下2つは後方互換フォールバック（KV 未設定時のみ使用）。
  RELEASE_TARBALL_URL?: string;
  RELEASE_SIG?: string;
  // リリース署名の公開鍵（Ed25519・公開情報）。クライアントの prebuild-update が検証に使う。
  RELEASE_PUBLIC_JWK?: string;
  // /api/release/publish の認証キー（CI と共有・secret）。
  RELEASE_PUBLISH_KEY?: string;
  // 団体ごと公開リポの自動生成／削除（throwaway・§2.2-2.3）。
  GITHUB_OWNER?: string;         // 例 "baku-team"
  GITHUB_TEMPLATE_REPO?: string; // 例 "baku-office-app"
  HOST_BASE_URL?: string;        // report.json に焼く当社ホストURL
  // secrets（wrangler secret put）
  GITHUB_TOKEN?: string; // repo 作成（Administration:write）＋Contents:write
  SIGNING_JWK?: string; // ライセンス署名（Ed25519秘密鍵JWK）
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  ADMIN_KEY?: string;
  // スタッフ管理者のGoogleメール（カンマ区切り）。ここに含まれるアカウントのみ管理ポータルを操作可。
  HOST_ADMIN_EMAILS?: string;
  // Stripe（§2・P5）。未設定のdevでは dev-confirm で入金をシミュレート。
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_PLUS?: string;
  STRIPE_PRICE_PRO?: string;
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
