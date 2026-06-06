/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION: KVNamespace;
  CLIENT_BASE_URL: string;
  // 団体ごと公開リポの自動生成（throwaway・§2.2）。
  GITHUB_OWNER?: string;         // 例 "baku-team"
  GITHUB_TEMPLATE_REPO?: string; // 例 "baku-office-app"
  HOST_BASE_URL?: string;        // report.json に焼く当社ホストURL
  GITHUB_TOKEN?: string;         // secret: repo 作成＋Contents 書込
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
