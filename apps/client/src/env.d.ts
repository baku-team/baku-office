/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  LICENSE: KVNamespace;
  MEDIA?: KVNamespace; // 専用ファイルKV（任意）。無ければ LICENSE を流用（配布は単一KV）。
  ASSETS: Fetcher;
  HOST_BASE_URL: string;
  // Deploy時に入力すると、アプリを開くだけで自動アクティベート（任意・セルフ導入）。
  LICENSE_ID?: string;
  // 同一アカウントでの host への配信路（workers.dev同士の直fetchはCFが遮断＝error1042）。
  // 別アカウント（本番の自己ホスト）では未設定＝HOST_BASE_URL(カスタムドメイン)へURL fetch。
  HOST?: Fetcher;
  // デプロイ環境。env.production の vars で "production" を設定。未設定＝dev/test。
  // 本番では MASTER_KEY 未投入時に KV 自動生成を禁止し暗号処理をブロックする（§10.1）。
  ENVIRONMENT?: string;
  // secrets（wrangler secret put）
  MASTER_KEY?: string;
  VERIFY_PUBLIC_JWK?: string;
  // 組織ログイン（Google OAuth・§6.2）。未設定時は dev ログイン。
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // 個人ログイン（LINE Login / Discord・§6.2）。未設定時は local(id/pass)。
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  // R2 高度モード（任意）
  MEDIA_R2?: R2Bucket;
  // Profile C：ローカルLLM（OpenAI互換エンドポイント。例 Ollama=http://localhost:11434）。
  LOCAL_AI_BASE_URL?: string;
  LOCAL_AI_MODEL?: string;
  // リマインダー drain（外部スケジューラ）保護用。
  INTERNAL_KEY?: string;
  // オートパイロット：GitHub OAuth App（device flow でトークン自動取得）。公開 client_id（秘密ではない）。
  GITHUB_OAUTH_CLIENT_ID?: string;
  // モデルID/単価の上書き（未設定＝既定値）。価格改定・モデル移行・廃止にコード変更なしで追随（core/models/config.ts）。
  GEMINI_MODEL?: string;
  CLAUDE_MODEL?: string;
  MODEL_PRICING?: string; // JSON: {"gemini":{"in":0.3,"out":2.5},"claude":{"in":3,"out":15}}
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {
    // ポータブルコアの実行コンテキスト（middleware で注入・移植性アーキ §7）。
    ctx: import("./core/ports").Ctx;
  }
}
